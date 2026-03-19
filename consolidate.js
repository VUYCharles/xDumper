'use strict';

const CalendarConsolidator = require('./src/consolidate');
const config               = require('./config');

/**
 * Standalone consolidation script.
 *
 * Reads all future events from the source calendar (googleCalendarId),
 * merges consecutive events separated by 20 minutes or less, and
 * writes the result to the destination calendar (consolidatedCalendarId).
 *
 * Can be run independently of the main sync:
 *   node consolidate.js
 *
 * Or chained after the main sync in a single systemd ExecStart or cron line:
 *   node main.js && node consolidate.js
 */
async function main() {
  const startTime = Date.now();

  console.log('');
  console.log('x-gcal — calendar consolidation');
  console.log(`Started: ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`);
  console.log('');

  if (!config.consolidatedCalendarId) {
    console.error(
      'Error: consolidatedCalendarId is not set in config.js\n' +
      'Add: const consolidatedCalendarId = "your-calendar-id@group.calendar.google.com";'
    );
    process.exit(1);
  }

  const consolidator = new CalendarConsolidator(config);

  try {
    await consolidator.authenticate();
    await consolidator.run();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('');
    console.log(`Completed in ${elapsed}s`);
    console.log('');

  } catch (err) {
    console.error(`\nFatal error: ${err.message}`);
    if (process.env.NODE_ENV !== 'production') console.error(err.stack);
    process.exit(1);
  }
}

main();
