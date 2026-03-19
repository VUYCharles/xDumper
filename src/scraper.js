'use strict';

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const ical = require('node-ical');
const fs   = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const DEBUG_DIR = path.join(__dirname, '../debug');
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

/**
 * xScraper
 *
 * Navigates the x x timetable application and downloads
 * per-week ICS calendar data.
 *
 * Technical notes:
 *
 * x is built on PrimeFaces (JSF). Every page carries a
 * javax.faces.ViewState token that is consumed on each POST and
 * regenerated in the response. Reusing a stale ViewState causes
 * the server to silently ignore the requested week and return the
 * current one instead.
 *
 * The Download button (form:j_idt121) triggers a standard HTML
 * form submit that returns an application/octet-stream ICS file.
 * Puppeteer intercepts this response at the browser level and
 * cannot read its body directly. Instead, we replicate the POST
 * via node-fetch, supplying the cookies and the fresh ViewState
 * collected from the live Puppeteer page.
 *
 * Week navigation is performed by clicking the FullCalendar
 * "next" button (fc-next-button), which is the only mechanism
 * that correctly advances the server-side JSF state. Writing
 * directly to form:week and submitting does not update the
 * server state; the calendar renders visually but the ViewState
 * still encodes the original week, so the ICS export always
 * returns the same data regardless of what form:week contains.
 */
class xScraper {
  constructor(config) {
    this.config       = config;
    this.browser      = null;
    this.page         = null;
    this._step        = 0;
    this._planningUrl = 'https://x-prod.x.fr/faces/Planning.xhtml';
  }

  // ---------------------------------------------------------------------------
  // Internal utilities
  // ---------------------------------------------------------------------------

  _log(message) {
    const ts = new Date().toLocaleTimeString('fr-FR');
    console.log(`[${ts}] ${message}`);
  }

  async _snapshot(label) {
    this._step++;
    const file = path.join(
      DEBUG_DIR,
      `${String(this._step).padStart(2, '0')}_${label}.png`
    );
    await this.page.screenshot({ path: file, fullPage: false }).catch(() => {});
    const title = await this.page.title().catch(() => '?');
    this._log(`screenshot: ${path.basename(file)} | "${title}" | ${this.page.url()}`);
  }

  // ---------------------------------------------------------------------------
  // Browser lifecycle
  // ---------------------------------------------------------------------------

  async init() {
    this._log('Starting browser...');

    const opts = {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--disable-blink-features=AutomationControlled',
      ],
    };

    if (this.config.useTor) {
      opts.args.push(`--proxy-server=socks5://127.0.0.1:${this.config.torPort || 9050}`);
      this._log(`Tor proxy enabled on port ${this.config.torPort || 9050}`);
    }

    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      opts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      this._log(`Chromium: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
    }

    this.browser = await puppeteer.launch(opts);
    this.page    = await this.browser.newPage();

    await this.page.setViewport({ width: 1920, height: 1080 });
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Safari/537.36'
    );

    this._log('Browser ready');
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  async login() {
    this._log(`Navigating to login page: ${this.config.xUrl}`);

    await this.page.goto(this.config.xUrl, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    await this._snapshot('01_login');
    await this.page.waitForSelector('#username', { timeout: 15000 });

    await this.page.type('#username', this.config.username, { delay: 40 });
    await this.page.type('#password', this.config.password, { delay: 40 });

    await Promise.all([
      this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      this.page.click('button[type="submit"], input[type="submit"]'),
    ]);

    if (this.page.url().toLowerCase().includes('login')) {
      throw new Error('Login failed — check username and password in config.js');
    }

    this._log('Authenticated successfully');
  }

  // ---------------------------------------------------------------------------
  // Planning page navigation
  // ---------------------------------------------------------------------------

  /**
   * Loads /faces/Planning.xhtml and waits for the form:week field
   * to be present, confirming the page is fully initialised.
   * Falls back to a PrimeFaces sidebar submit if a direct GET
   * returns an empty page (can occur on first load after login).
   */
  async _loadPlanningPage() {
    await this.page.goto(this._planningUrl, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Session may have expired
    if (this.page.url().toLowerCase().includes('login')) {
      this._log('Session expired — re-authenticating');
      await this.login();
      await this.page.goto(this._planningUrl, {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
    }

    // Direct GET sometimes returns the shell without the schedule widget
    if (!await this.page.$('#form\\:week').catch(() => null)) {
      this._log('form:week absent — navigating via sidebar');

      await this.page.goto(
        'https://x-prod.x.fr/faces/MainMenuPage.xhtml',
        { waitUntil: 'networkidle2', timeout: 30000 }
      );

      await this.page.waitForSelector('#form\\:sidebar', { timeout: 10000 });

      await Promise.all([
        this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
        this.page.evaluate(() => {
          PrimeFaces.addSubmitParam('form', {
            'form:sidebar':         'form:sidebar',
            'form:sidebar_menuid':  '1',
          }).submit('form');
        }),
      ]);

      await this.page.waitForSelector('#form\\:week', { timeout: 15000 });
    }

    await this.page.waitForNetworkIdle({ timeout: 8000, idleTime: 1500 }).catch(() => {});
    await this._sleep(500);
  }

  async navigateToPlanning() {
    this._log('Loading planning page...');
    await this._loadPlanningPage();
    await this._snapshot('02_planning_loaded');
    this._log('Planning page ready');
  }

  // ---------------------------------------------------------------------------
  // Week navigation
  // ---------------------------------------------------------------------------

  /**
   * Clicks the FullCalendar "next week" button and waits for the
   * Ajax response that updates the schedule and ViewState.
   *
   * This is the only reliable way to advance the server-side JSF
   * state. Writing directly to form:week via JavaScript does not
   * update the ViewState; the ICS export then returns stale data.
   */
  async _clickNext() {
    await this.page.evaluate(() => {
      const btn =
        document.querySelector('.fc-next-button') ||
        document.querySelector('[title="Next"]')  ||
        document.querySelector('[title="Suivant"]');
      if (btn) btn.click();
    });

    await this.page.waitForNetworkIdle({ timeout: 15000, idleTime: 2000 }).catch(() => {});
    await this._sleep(2000);
  }

  async _getCurrentWeek() {
    return await this.page.evaluate(() => {
      // form:week is not updated by PrimeFaces Ajax navigation —
      // its DOM value always shows the week at page load time.
      // The fc-toolbar title (e.g. "15 - 21 March 2026") is the only
      // reliable indicator of the currently displayed week.
      // We parse it back to an ISO week number.
      const titleEl = document.querySelector('.fc-toolbar-title, .fc-center h2, h2.fc-toolbar-title');
      if (titleEl) {
        const text = titleEl.textContent.trim();
        // Try to extract any date from the title to compute the ISO week
        const match = text.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
        if (match) {
          const months = {
            january:1,february:2,march:3,april:4,may:5,june:6,
            july:7,august:8,september:9,october:10,november:11,december:12,
            janvier:1,février:2,mars:3,avril:4,mai:5,juin:6,
            juillet:7,août:8,septembre:9,octobre:10,novembre:11,décembre:12,
          };
          const day   = parseInt(match[1], 10);
          const month = months[match[2].toLowerCase()];
          const year  = parseInt(match[3], 10);
          if (month) {
            const d   = new Date(Date.UTC(year, month - 1, day));
            const dow = d.getUTCDay() || 7;
            d.setUTCDate(d.getUTCDate() + 4 - dow);
            const ys  = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
            const wk  = Math.ceil((((d - ys) / 86400000) + 1) / 7);
            return String(wk).padStart(2, '0') + '-' + d.getUTCFullYear();
          }
        }
      }
      // Fall back to the input field value
      const input = document.getElementById('form:week');
      return input ? input.value : null;
    });
  }

  /**
   * Returns the signed number of weeks between two "WW-YYYY" strings.
   * Positive means toStr is in the future relative to fromStr.
   */
  _weekDiff(fromStr, toStr) {
    if (!fromStr) return 1;

    const toMonday = (s) => {
      const [ww, yyyy] = s.split('-').map(Number);
      const jan4 = new Date(Date.UTC(yyyy, 0, 4));
      const mon1 = new Date(jan4);
      mon1.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
      const mon = new Date(mon1);
      mon.setUTCDate(mon1.getUTCDate() + (ww - 1) * 7);
      return mon;
    };

    return Math.round(
      (toMonday(toStr) - toMonday(fromStr)) / (7 * 24 * 60 * 60 * 1000)
    );
  }

  // ---------------------------------------------------------------------------
  // ICS download
  // ---------------------------------------------------------------------------

  /**
   * Navigates the browser to the target week by clicking the
   * FullCalendar next button as many times as needed, then
   * replicates the Download button POST via node-fetch to retrieve
   * the ICS response body.
   *
   * The ICS file is saved under debug/week_<weekStr>.ics for
   * inspection. If the server returns an HTML error page instead
   * of an ICS, it is saved as week_<weekStr>_bad.html.
   */
  async downloadWeekICS(weekStr) {
    this._log(`Processing week ${weekStr}`);

    // We navigate using only one _clickNext() per week relative to
    // the previous position. The page is NEVER reloaded between weeks
    // because _loadPlanningPage() would reset the browser back to the
    // current real-world week, forcing us to click N times from scratch
    // for every subsequent week.
    //
    // form:week is not reliable as a position indicator — PrimeFaces
    // does not update it in the DOM after an Ajax navigation. We track
    // position ourselves via this._currentWeekIndex.

    const currentWeek = await this._getCurrentWeek();
    const clicks      = this._weekDiff(currentWeek, weekStr);

    this._log(`Browser position: ${currentWeek} — clicks needed: ${clicks}`);

    if (clicks < 0) {
      // Should not happen when weeks are processed in ascending order,
      // but handle it by reloading and re-navigating from scratch.
      this._log('Target week is behind current position — reloading planning page');
      await this._loadPlanningPage();
      const newCurrent = await this._getCurrentWeek();
      const newClicks  = this._weekDiff(newCurrent, weekStr);
      for (let i = 0; i < newClicks; i++) {
        this._log(`Next click ${i + 1}/${newClicks}`);
        await this._clickNext();
      }
    } else {
      for (let i = 0; i < clicks; i++) {
        this._log(`Next click ${i + 1}/${clicks}`);
        await this._clickNext();
      }
    }

    await this._snapshot(`week_${weekStr}_ready`);

    // Collect all form fields with the current ViewState
    const formParams = await this.page.evaluate(() => {
      const params = {};
      document
        .querySelectorAll('form#form input, form#form select')
        .forEach((el) => {
          if (el.name) params[el.name] = el.value || '';
        });
      return params;
    });

    const vs = formParams['javax.faces.ViewState'];
    if (!vs) {
      this._log('ViewState not found — skipping week');
      return [];
    }

    this._log(`ViewState: ${vs.slice(0, 25)}...`);

    // Add the Download button parameter.
    // We do NOT use form:week here because the DOM value is unreliable
    // after Ajax navigation. The server-side state is already correct
    // thanks to the _clickNext() calls above.
    formParams['form:j_idt121'] = 'form:j_idt121';
    formParams['form']          = 'form';

    const cookies   = await this.page.cookies();
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    this._log('Sending ICS download request...');

    let icsBody = null;
    try {
      const { default: fetch } = await import('node-fetch');

      const response = await fetch(
        'https://x-prod.x.fr/faces/Planning.xhtml',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie':        cookieStr,
            'Referer':       'https://x-prod.x.fr/faces/Planning.xhtml',
            'Origin':        'https://x-prod.x.fr',
            'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept':        'text/html,application/xhtml+xml,*/*',
          },
          body:     new URLSearchParams(formParams).toString(),
          redirect: 'follow',
        }
      );

      const ct   = response.headers.get('content-type') || '';
      const buf  = await response.buffer();
      const text = buf.toString('utf-8');

      this._log(`Response: HTTP ${response.status} | ${ct.slice(0, 60)}`);

      if (text.includes('BEGIN:VCALENDAR')) {
        icsBody = text;
      } else {
        fs.writeFileSync(
          path.join(DEBUG_DIR, `week_${weekStr}_bad.html`),
          text.slice(0, 5000)
        );
        this._log(`Response is not an ICS file — saved to debug/week_${weekStr}_bad.html`);
      }
    } catch (err) {
      this._log(`Fetch error: ${err.message}`);
    }

    if (!icsBody) {
      await this._snapshot(`error_week_${weekStr}_no_ics`);
      return [];
    }

    this._log(`ICS received (${icsBody.length} bytes)`);

    const firstDate = this._extractFirstDate(icsBody);
    this._log(`First event date in ICS: ${firstDate || 'unknown'}`);

    fs.writeFileSync(path.join(DEBUG_DIR, `week_${weekStr}.ics`), icsBody);

    const events = this._parseICS(icsBody, weekStr);
    this._log(`Parsed ${events.length} event(s)`);
    return events;
  }

  // ---------------------------------------------------------------------------
  // ICS parsing
  // ---------------------------------------------------------------------------

  _extractFirstDate(icsContent) {
    const m = icsContent.match(/DTSTART[^:]*:(\d{8})/);
    if (!m) return null;
    const d = m[1];
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  }

  _parseICS(icsContent, weekLabel) {
    const events = [];

    try {
      const parsed = ical.sync.parseICS(icsContent);

      for (const key of Object.keys(parsed)) {
        const ev = parsed[key];
        if (ev.type !== 'VEVENT') continue;

        const start = ev.start ? new Date(ev.start) : null;
        const end   = ev.end   ? new Date(ev.end)   : null;

        if (!start || isNaN(start.getTime())) continue;

        events.push({
          title:       (ev.summary     || 'Untitled').trim(),
          start:       start.toISOString(),
          end:         end && !isNaN(end.getTime())
                         ? end.toISOString()
                         : new Date(start.getTime() + 3_600_000).toISOString(),
          location:    (ev.location    || '').trim(),
          description: (ev.description || '').trim(),
        });
      }
    } catch (err) {
      this._log(`ICS parse error (${weekLabel}): ${err.message}`);
    }

    return events;
  }

  // ---------------------------------------------------------------------------
  // Week number utilities
  // ---------------------------------------------------------------------------

  /**
   * Returns an array of ISO week strings ("WW-YYYY") starting from
   * the current week, covering the next <count> weeks.
   */
  getWeekNumbers(count) {
    const weeks = [];
    const now   = new Date();

    for (let i = 0; i < count; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i * 7);
      const { week, year } = this._isoWeek(d);
      const s = `${String(week).padStart(2, '0')}-${year}`;
      if (!weeks.includes(s)) weeks.push(s);
    }

    return weeks;
  }

  _isoWeek(date) {
    const d   = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return {
      week: Math.ceil((((d - yearStart) / 86_400_000) + 1) / 7),
      year: d.getUTCFullYear(),
    };
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = xScraper;
