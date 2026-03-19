'use strict';

const xScraper      = require('./src/scraper');
const GoogleCalendarSync = require('./src/google-calendar');
const config             = require('./config');

/**
 * Entry point.
 *
 * Execution order:
 *   1. Authenticate with Google Calendar and verify calendar access.
 *   2. Delete all future events previously created by this tool.
 *   3. Connect to x and navigate to the timetable page.
 *   4. For each target week: download the ICS, parse it, insert
 *      events into Google Calendar before moving to the next week.
 *
 * Deleting before scraping (step 2) rather than per-week (which was
 * the original approach) prevents a race condition where events
 * inserted in week N are deleted when processing week N+1 if the
 * two weeks share an overlapping time range boundary.
 *
 * Processing is intentionally sequential — one week at a time — to
 * avoid overwhelming the x server and to allow partial results
 * to be written to Google Calendar in case the process is interrupted.
 */
async function main() {
  const startTime = Date.now();

  console.log('');
  console.log('x-gcal — timetable sync');
  console.log(`Started: ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`);
  console.log('');

  const scraper = new xScraper(config);
  const gcal    = new GoogleCalendarSync(config);

  try {
    // ------------------------------------------------------------------
    // Step 1: Google Calendar authentication
    // ------------------------------------------------------------------
    console.log('[main] Authenticating with Google Calendar...');
    await gcal.authenticate();

    // ------------------------------------------------------------------
    // Step 2: Determine target weeks and clear existing events
    // ------------------------------------------------------------------
    const weekCount   = config.weeksToScrape || 17;
    const weekNumbers = scraper.getWeekNumbers(weekCount);

    // Deletion covers today through two years in the future so that
    // events from any previous run are removed regardless of how many
    // weeks that run covered.
    const today     = new Date();
    today.setHours(0, 0, 0, 0);
    const farFuture = new Date(today);
    farFuture.setFullYear(farFuture.getFullYear() + 2);

    console.log(
      `[main] Clearing events from ${today.toISOString().slice(0, 10)} ` +
      `to ${farFuture.toISOString().slice(0, 10)}`
    );
    await gcal.deleteAllInRange(today.toISOString(), farFuture.toISOString());

    // ------------------------------------------------------------------
    // Step 3: Connect to x
    // ------------------------------------------------------------------
    console.log('');
    console.log(
      `[main] Weeks to process (${weekNumbers.length}): ${weekNumbers.join(', ')}`
    );
    console.log('');

    console.log('[main] Connecting to x...');
    await scraper.init();
    await scraper.login();
    await scraper.navigateToPlanning();

    // ------------------------------------------------------------------
    // Step 4: Per-week scrape and insert
    // ------------------------------------------------------------------
    let totalCreated = 0;
    let totalErrors  = 0;

    for (const week of weekNumbers) {
      console.log(`--- ${week} ${'─'.repeat(40 - week.length)}`);

      const events = await scraper.downloadWeekICS(week);

      if (events.length === 0) {
        console.log('[main] No events found — skipping');
        console.log('');
        continue;
      }

      for (const ev of events) {
        const start = new Date(ev.start).toLocaleString('fr-FR', {
          timeZone: 'Europe/Paris',
        });
        const room = ev.location ? `  [${ev.location}]` : '';
        console.log(`  ${ev.title}${room}  —  ${start}`);
      }

      const result = await gcal.insertEvents(events);
      totalCreated += result.created;
      totalErrors  += result.errors;

      console.log(
        `[main] Inserted ${result.created}` +
        (result.errors ? `  (${result.errors} errors)` : '')
      );
      console.log('');
    }

    // ------------------------------------------------------------------
    // Summary
    // ------------------------------------------------------------------
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('='.repeat(44));
    console.log(`Completed in ${elapsed}s`);
    console.log(`${totalCreated} event(s) added to Google Calendar`);
    if (totalErrors) console.log(`${totalErrors} error(s)`);
    console.log('='.repeat(44));
    console.log('');

  } catch (err) {
    console.error('');
    console.error(`Fatal error: ${err.message}`);
    if (process.env.NODE_ENV !== 'production') console.error(err.stack);
    process.exit(1);
  } finally {
    await scraper.close();
  }
}

main();
