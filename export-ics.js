'use strict';

const readline = require('readline');
const fs       = require('fs');
const path     = require('path');
const AurionScraper = require('./src/scraper');

/**
 * export-ics.js
 *
 * Asks for Aurion credentials, scrapes the timetable, and writes
 * a single .ics file importable into any calendar application.
 *
 * No Google API, no OAuth, no config file required.
 *
 * Usage:
 *   node export-ics.js
 */

function ask(question, opts = {}) {
  const rl = readline.createInterface({
    input:  process.stdin,
    output: opts.hidden ? null : process.stdout,
  });

  return new Promise((resolve) => {
    if (opts.hidden) {
      process.stdout.write(question);
      // Read one line from stdin without echoing
      process.stdin.setEncoding('utf8');
      let input = '';
      process.stdin.once('data', (data) => {
        input = data.toString().trim();
        process.stdout.write('\n');
        rl.close();
        resolve(input);
      });
      rl.on('close', () => {});
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

function toIcalDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeIcal(str) {
  return (str || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g,  '\\;')
    .replace(/,/g,  '\\,')
    .replace(/\n/g, '\\n');
}

function foldLine(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const result = [];
  let current  = '';
  for (const char of line) {
    if (Buffer.byteLength(current + char, 'utf8') > 75) {
      result.push(current);
      current = ' ' + char;
    } else {
      current += char;
    }
  }
  if (current) result.push(current);
  return result.join('\r\n');
}

function buildICS(events) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//aurion-gcal//export-ics//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-TIMEZONE:Europe/Paris',
  ];

  for (const ev of events) {
    const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@aurion-gcal`;
    lines.push('BEGIN:VEVENT');
    lines.push(foldLine(`UID:${uid}`));
    lines.push(`DTSTAMP:${toIcalDate(new Date())}`);
    lines.push(`DTSTART:${toIcalDate(new Date(ev.start))}`);
    lines.push(`DTEND:${toIcalDate(new Date(ev.end))}`);
    lines.push(foldLine(`SUMMARY:${escapeIcal(ev.title)}`));
    if (ev.location)    lines.push(foldLine(`LOCATION:${escapeIcal(ev.location)}`));
    if (ev.description) lines.push(foldLine(`DESCRIPTION:${escapeIcal(ev.description)}`));
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

async function main() {
  console.log('');
  console.log('aurion-gcal — ICS export');
  console.log('');

  const username      = await ask('Aurion username (email) : ');
  const password      = await ask('Aurion password         : ');
  const rawWeeks      = await ask('Weeks to export   [17]  : ');
  const weeksToScrape = parseInt(rawWeeks, 10) || 17;

  console.log('');

  const config = {
    aurionUrl:    'https://aurion-prod.enac.fr/faces/Login.xhtml',
    username,
    password,
    weeksToScrape,
    useTor:       false,
    torPort:      9050,
  };

  const scraper   = new AurionScraper(config);
  const allEvents = [];

  try {
    await scraper.init();
    await scraper.login();
    await scraper.navigateToPlanning();

    const weeks = scraper.getWeekNumbers(weeksToScrape);
    console.log(`Exporting ${weeks.length} weeks...\n`);

    for (const week of weeks) {
      process.stdout.write(`  ${week} ... `);
      const events = await scraper.downloadWeekICS(week);
      allEvents.push(...events);
      console.log(`${events.length} event(s)`);
    }

  } finally {
    await scraper.close();
  }

  if (allEvents.length === 0) {
    console.log('\nNo events found.');
    process.exit(0);
  }

  const icsContent = buildICS(allEvents);
  const filename   = `aurion-${new Date().toISOString().slice(0, 10)}.ics`;
  const filepath   = path.join(process.cwd(), filename);

  fs.writeFileSync(filepath, icsContent, 'utf8');

  console.log('');
  console.log(`${allEvents.length} event(s) exported to ${filename}`);
  console.log('');
  console.log('Import into Google Calendar : calendar.google.com → Settings → Import & export');
  console.log('Import into Apple Calendar  : File → Import');
  console.log('');
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
