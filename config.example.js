/**
 * x-gcal configuration
 *
 * Copy this file to config.js and fill in your credentials.
 * config.js is listed in .gitignore and must never be committed.
 *
 *   cp config.example.js config.js
 */

// ---------------------------------------------------------------------------
// x credentials
// ---------------------------------------------------------------------------

const xUrl = 'https://x-prod.x.fr/faces/Login.xhtml';
const username  = 'firstname.lastname@x.fr';
const password  = 'your_password';

// Number of weeks to synchronise starting from the current week.
// The expression below computes the exact number of weeks covering
// the next four calendar months, which handles months of varying
// length correctly.
const weeksToScrape = (() => {
  const now = new Date();
  const end = new Date(now);
  end.setMonth(end.getMonth() + 4);
  return Math.ceil((end - now) / (7 * 24 * 60 * 60 * 1000));
})();

// ---------------------------------------------------------------------------
// Google Calendar
// ---------------------------------------------------------------------------

// The ID of the target calendar.
//   'primary'                         — your main Google Calendar
//   'your.email@gmail.com'            — also valid for the main calendar
//   'xxx@group.calendar.google.com'   — a secondary calendar
//
// To find the ID of a secondary calendar:
//   Google Calendar -> Settings -> [calendar name] -> "Integrate calendar"
const googleCalendarId = 'primary';

// ---------------------------------------------------------------------------
// Authentication — choose one of the two options below.
// ---------------------------------------------------------------------------

// Option A: Service Account (recommended for headless servers)
//
// 1. Create a project at https://console.cloud.google.com
// 2. Enable the Google Calendar API
// 3. Create a Service Account, download the JSON key
// 4. Share your calendar with the service account email address
//    (permission: "Make changes to events")
// 5. Set the path below
const serviceAccountKeyFile = ''; // e.g. './service-account-key.json'

// Option B: OAuth2 (suitable for personal use)
//
// Run `node scripts/oauth-setup.js` on a machine with a browser,
// follow the authorisation flow, and paste the returned values here.
const oauth2Credentials = {
  clientId:     'YOUR_CLIENT_ID.apps.googleusercontent.com',
  clientSecret: 'YOUR_CLIENT_SECRET',
  redirectUri:  'http://localhost:3000/oauth2callback',
  refreshToken: 'YOUR_REFRESH_TOKEN',
};

// ---------------------------------------------------------------------------
// Optional: Tor proxy
//
// Some hosting providers (e.g. OVH) have their IP ranges blocked by
// x. Enable Tor to route traffic through an anonymous circuit.
// Requires the `tor` package: apt install tor
// ---------------------------------------------------------------------------
const useTor  = false;
const torPort = 9050;

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Consolidation (consolidate.js)
// ---------------------------------------------------------------------------
const consolidatedCalendarId  = 'id2'; // ID de l'agenda de destination
const consolidationGapMinutes = 20;    // seuil de fusion en minutes

module.exports = {
  xUrl,
  username,
  password,
  weeksToScrape,
  googleCalendarId,
  serviceAccountKeyFile,
  oauth2Credentials,
  useTor,
  torPort,
  consolidatedCalendarId,
  consolidationGapMinutes,
};
