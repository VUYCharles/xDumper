'use strict';

const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

/**
 * CalendarConsolidator
 *
 * Reads all future events from the source calendar (created by
 * x-gcal), merges consecutive events separated by 20 minutes
 * or less into single blocks, and writes the result to a separate
 * destination calendar.
 *
 * Merging logic:
 *   Events are sorted by start time. Two adjacent events A and B
 *   are merged when B.start - A.end <= 20 minutes. The merged block
 *   inherits A.start and B.end. If more than two events are
 *   consecutive, they are all collapsed into one block. The summary
 *   of the merged event lists all constituent titles.
 *
 * The destination calendar is cleared (for the same time range)
 * before each write, using the same source=x-consolidated tag
 * used at insertion time.
 */
class CalendarConsolidator {
  constructor(config) {
    this.config      = config;
    this.sourceId    = config.googleCalendarId;
    this.destId      = config.consolidatedCalendarId;
    this.auth        = null;
    this.calendar    = null;
    this.GAP_MS      = (config.consolidationGapMinutes ?? 20) * 60 * 1000;
  }

  // ---------------------------------------------------------------------------
  // Authentication — reuses the same method as GoogleCalendarSync
  // ---------------------------------------------------------------------------

  async authenticate() {
    if (this.config.serviceAccountKeyFile) {
      const keyFile = path.resolve(this.config.serviceAccountKeyFile);
      if (!fs.existsSync(keyFile))
        throw new Error(`Service account key file not found: ${keyFile}`);

      const auth = new google.auth.GoogleAuth({
        keyFile,
        scopes: ['https://www.googleapis.com/auth/calendar'],
      });
      this.auth = await auth.getClient();
      console.log('[consolidate] Authenticated via Service Account');

    } else if (this.config.oauth2Credentials) {
      const { clientId, clientSecret, redirectUri, refreshToken } =
        this.config.oauth2Credentials;
      const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
      client.setCredentials({ refresh_token: refreshToken });
      this.auth = client;
      console.log('[consolidate] Authenticated via OAuth2');

    } else {
      throw new Error('No authentication method configured in config.js');
    }

    this.calendar = google.calendar({ version: 'v3', auth: this.auth });

    // Verify both calendars are accessible
    for (const [label, id] of [['source', this.sourceId], ['destination', this.destId]]) {
      try {
        const res = await this.calendar.calendars.get({ calendarId: id });
        console.log(`[consolidate] ${label} calendar: "${res.data.summary}" (${res.data.id})`);
      } catch (err) {
        const d = err.response?.data?.error || {};
        throw new Error(
          `Cannot access ${label} calendar "${id}": ${d.message || err.message}`
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Read source events
  // ---------------------------------------------------------------------------

  async fetchSourceEvents(timeMin, timeMax) {
    const items    = [];
    let pageToken  = null;

    do {
      const params = {
        calendarId:              this.sourceId,
        timeMin,
        timeMax,
        singleEvents:            true,
        orderBy:                 'startTime',
        maxResults:              500,
        privateExtendedProperty: 'source=x-scraper',
      };
      if (pageToken) params.pageToken = pageToken;

      const res = await this.calendar.events.list(params);
      items.push(...(res.data.items || []));
      pageToken = res.data.nextPageToken || null;
    } while (pageToken);

    console.log(`[consolidate] ${items.length} source event(s) fetched`);
    return items;
  }

  // ---------------------------------------------------------------------------
  // Merging logic
  // ---------------------------------------------------------------------------

  /**
   * Groups events into consecutive blocks. Two events belong to the
   * same block when the gap between them is <= GAP_MS.
   * Returns an array of merged event objects ready for insertion.
   */
  mergeEvents(events) {
    if (events.length === 0) return [];

    // Normalise to plain objects with Date instances
    const sorted = events
      .map((ev) => ({
        title:    ev.summary || 'Untitled',
        start:    new Date(ev.start.dateTime || ev.start.date),
        end:      new Date(ev.end.dateTime   || ev.end.date),
        location: ev.location || '',
      }))
      .filter((ev) => !isNaN(ev.start.getTime()))
      .sort((a, b) => a.start - b.start);

    const blocks  = [];
    let current   = { ...sorted[0], titles: [sorted[0].title] };

    for (let i = 1; i < sorted.length; i++) {
      const ev  = sorted[i];
      const gap = ev.start.getTime() - current.end.getTime();

      if (gap <= this.GAP_MS) {
        // Extend the current block
        if (ev.end > current.end) current.end = ev.end;
        current.titles.push(ev.title);
        if (ev.location && !current.location) current.location = ev.location;
      } else {
        blocks.push(this._buildEvent(current));
        current = { ...ev, titles: [ev.title] };
      }
    }
    blocks.push(this._buildEvent(current));

    console.log(
      `[consolidate] ${sorted.length} event(s) merged into ${blocks.length} block(s)`
    );
    return blocks;
  }

  _buildEvent(block) {
    // Deduplicate titles while preserving order
    const seen   = new Set();
    const titles = block.titles.filter((t) => {
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    });

    const resource = {
      summary:     titles.join(' / '),
      description: `Consolidated from ${block.titles.length} block(s):\n${block.titles.join('\n')}`,
      start:       { dateTime: block.start.toISOString(), timeZone: 'Europe/Paris' },
      end:         { dateTime: block.end.toISOString(),   timeZone: 'Europe/Paris' },
      extendedProperties: {
        private: { source: 'x-consolidated' },
      },
    };

    if (block.location) resource.location = block.location;
    return resource;
  }

  // ---------------------------------------------------------------------------
  // Clear destination calendar
  // ---------------------------------------------------------------------------

  async clearDestination(timeMin, timeMax) {
    let deleted   = 0;
    let pageToken = null;

    do {
      const params = {
        calendarId:              this.destId,
        timeMin,
        timeMax,
        singleEvents:            true,
        maxResults:              500,
        privateExtendedProperty: 'source=x-consolidated',
      };
      if (pageToken) params.pageToken = pageToken;

      const res = await this.calendar.events.list(params).catch((err) => {
        const d = err.response?.data?.error || {};
        console.error(`[consolidate] List error: ${d.message || err.message}`);
        return { data: { items: [], nextPageToken: null } };
      });

      pageToken = res.data.nextPageToken || null;

      for (const ev of res.data.items || []) {
        try {
          await this.calendar.events.delete({ calendarId: this.destId, eventId: ev.id });
          deleted++;
          await this._sleep(80);
        } catch (err) {
          if (err.response?.status !== 410) {
            const d = err.response?.data?.error || {};
            console.warn(`[consolidate] Could not delete ${ev.id}: ${d.message || err.message}`);
          }
        }
      }
    } while (pageToken);

    console.log(`[consolidate] Cleared ${deleted} existing consolidated event(s)`);
    return deleted;
  }

  // ---------------------------------------------------------------------------
  // Insert merged events
  // ---------------------------------------------------------------------------

  async insertBlocks(blocks) {
    let created = 0;
    let errors  = 0;

    for (const resource of blocks) {
      try {
        await this.calendar.events.insert({
          calendarId: this.destId,
          resource,
        });
        created++;
        await this._sleep(120);
      } catch (err) {
        const d = err.response?.data?.error || {};
        console.error(`[consolidate] Insert failed for "${resource.summary}": ${d.message || err.message}`);
        errors++;
      }
    }

    console.log(`[consolidate] Inserted ${created} consolidated block(s)${errors ? `, ${errors} error(s)` : ''}`);
    return { created, errors };
  }

  // ---------------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------------

  async run() {
    const today     = new Date();
    today.setHours(0, 0, 0, 0);
    const farFuture = new Date(today);
    farFuture.setFullYear(farFuture.getFullYear() + 2);

    const timeMin = today.toISOString();
    const timeMax = farFuture.toISOString();

    console.log(`[consolidate] Time range: ${timeMin.slice(0, 10)} → ${timeMax.slice(0, 10)}`);
    console.log(`[consolidate] Gap threshold: ${this.GAP_MS / 60000} minutes`);

    // 1. Fetch source events
    const sourceEvents = await this.fetchSourceEvents(timeMin, timeMax);
    if (sourceEvents.length === 0) {
      console.log('[consolidate] No source events found — nothing to consolidate');
      return;
    }

    // 2. Merge
    const blocks = this.mergeEvents(sourceEvents);

    // 3. Clear destination
    await this.clearDestination(timeMin, timeMax);

    // 4. Insert
    await this.insertBlocks(blocks);
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = CalendarConsolidator;
