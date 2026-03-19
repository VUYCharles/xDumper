'use strict';

const readline = require('readline');
const xScraper      = require('./src/scraper');
const GoogleCalendarSync = require('./src/google-calendar');

/**
 * sync-once.js
 *
 * Interactive one-shot sync. Asks for credentials at the terminal,
 * performs the sync, then exits. No config file required.
 *
 * Usage:
 *   node sync-once.js
 */

const rl = readline.createInterface({
  input:  process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let input = '';
    stdin.on('data', function handler(ch) {
      if (ch === '\n' || ch === '\r') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', handler);
        process.stdout.write('\n');
        resolve(input);
      } else if (ch === '\u0003') {
        process.exit();
      } else if (ch === '\u007f') {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
          process.stdout.write(question + '*'.repeat(input.length));
        }
      } else {
        input += ch;
        process.stdout.write('*');
      }
    });
  });
}

async function main() {
  console.log('');
  console.log('x-gcal — one-shot sync');
  console.log('');

  // --- Collect credentials ---------------------------------------------------

  const xUrl = 'https://x-prod.x.fr/faces/Login.xhtml';

  const username     = await ask('x username (email): ');
  const password     = await askHidden('x password: ');

  console.log('');
  console.log('Google OAuth2 credentials');
  console.log('(obtain them by running: node scripts/oauth-setup.js)');
  console.log('');

  const clientId     = await ask('Client ID: ');
  const clientSecret = await ask('Client Secret: ');
  const refreshToken = await ask('Refresh Token: ');
  const calendarId   = await ask('Calendar ID [primary]: ') || 'primary';

  const rawWeeks     = await ask('Weeks to sync [17]: ');
  const weeksToScrape = parseInt(rawWeeks, 10) || 17;

  rl.close();

  console.log('');
  console.log(`Syncing ${weeksToScrape} weeks into calendar "${calendarId}"...`);
  console.log('');

  // --- Build config object ---------------------------------------------------

  const config = {
    xUrl,
    username,
    password,
    weeksToScrape,
    googleCalendarId:   calendarId,
    serviceAccountKeyFile: '',
    oauth2Credentials: {
      clientId,
      clientSecret,
      redirectUri:  'http://localhost:3000/oauth2callback',
      refreshToken,
    },
    useTor:  false,
    torPort: 9050,
  };

  // --- Run sync --------------------------------------------------------------

  const scraper = new xScraper(config);
  const gcal    = new GoogleCalendarSync(config);

  try {
    await gcal.authenticate();

    const weekNumbers = scraper.getWeekNumbers(weeksToScrape);

    const today     = new Date();
    today.setHours(0, 0, 0, 0);
    const farFuture = new Date(today);
    farFuture.setFullYear(farFuture.getFullYear() + 2);

    console.log(`Clearing existing events (${today.toISOString().slice(0,10)} → ${farFuture.toISOString().slice(0,10)})...`);
    await gcal.deleteAllInRange(today.toISOString(), farFuture.toISOString());

    await scraper.init();
    await scraper.login();
    await scraper.navigateToPlanning();

    let total = 0;

    for (const week of weekNumbers) {
      process.stdout.write(`  Week ${week}... `);
      const events = await scraper.downloadWeekICS(week);
      if (events.length === 0) {
        console.log('no events');
        continue;
      }
      const result = await gcal.insertEvents(events);
      total += result.created;
      console.log(`${result.created} event(s) added`);
    }

    console.log('');
    console.log(`Done — ${total} event(s) added to Google Calendar.`);
    console.log('');

  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  } finally {
    await scraper.close();
  }
}

main();
