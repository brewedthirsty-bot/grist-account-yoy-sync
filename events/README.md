# FDR Event Sync

Custom widget for the **FDR Restaurant Sales** Grist Desktop document. The older Reporting Sync at the repository root is unchanged.

Widget URL: https://brewedthirsty-bot.github.io/grist-account-yoy-sync/events/?v=1.2.1

Version 1.2 adds **Riverview Health Arena at Innovation Mile** as a fourth venue and direct AMP city collection. GitHub servers receive HTTP 403 from the city calendar, including its public export links. The advertised city REST API permits normal browser CORS requests from this widget's origin. The page therefore fetches AMP directly on the Grist computer without credentials; GitHub continues the other feeds. The live direct connection still needs verification in the user's Grist app.

## Add to Grist

1. In FDR Restaurant Sales, add a **new page**, choose **Custom**, and select the **Events** table. Name the page **Event Sync**.
2. Choose **Custom URL**, paste the widget URL above, and grant **Full document access**.
3. In Connection settings, follow **Create a GitHub read token**. Use a **fine-grained** personal access token, resource owner **brewedthirsty-bot**, **Only select repositories → fdr-event-calendar**, **Repository permissions → Contents → Read-only**. Metadata read access is automatic. Choose an expiration you can maintain. Do not add write permissions.
4. Paste the token into the widget, optionally check **Remember token on this computer**, then **Connect & preview**. Do not paste the token into chat, a Grist cell, or GitHub code. This is a separate credential from the Ticketmaster Consumer Key.
5. Review the preview, click **Sync events**, and check for **Grist verified the snapshot**. A yellow source warning can accompany a verified sync: successful feeds update while a failed feed's older records are retained.

After the first verified sync, automatic checks run on page opening and every 30 minutes while the page is visible. Returning to the page after 30 minutes also checks. The token must be remembered for reopening without another paste. GitHub collects independently; this widget cannot update a closed Grist Desktop app or an inactive page. Auto-sync preferences and last verified timestamps are stored on this computer, per Grist document, without Grist's extra Save-options action.

## Tables and types

Requires `Events` and `Venues` from the collector's CSVs. IDs must match the original CSV column IDs. `Event_Key`, `Venue_Key`, `Source_Key`, and `Source_Event_ID` remain **Text**. References belong in additional columns. The first direct AMP sync creates **Source_Checks** if missing, so local city freshness and failures persist in the document. An existing compatible table is reused. No repeat CSV import or new GitHub token is needed for the fourth venue.

`Event_Date` supports Date or Text; Date is recommended for Calendar references. `Currently_Listed` and `Review_Required` support Toggle/Bool or Text. Source timestamps support Text or DateTime; empty timestamps remain empty. Source counts support Integer, Numeric, or Text. Other source columns must be Text. The widget checks metadata and pauses on incompatible types, formula-managed source columns, missing keys, and duplicates.

The first sync adds **Events.Source_Review_Note** (Text) and copies current collector review notes into it. Existing `Review_Note` values are left intact for local edits. Use an extra `Local_Notes` column if desired. `Review_Required` is a collector-owned flag.

## Write behavior

- Reads the branch head, then downloads Venues, Events, Source_Checks, and run_report from **that same commit** using GitHub's authenticated Contents API. All requests are GET, with redirects prohibited. No token is put in a URL.
- Checks CSV structure, stable keys, venue/source links, dates, flags, report counts, and source-attempt timestamps before planning writes. A partial collector report is allowed and displayed explicitly.
- Validates the report's declared venue keys, allowing the fourth venue without removing the completeness check. A city source with `success: null` must be explicitly delegated to Grist; it is never treated as a successful GitHub refresh.
- Fetches the advertised City of Fishers REST API through normal browser CORS: GET, no credentials or Authorization header, no redirects, no proxy, no altered browser identity. A paginated complete response is required. City IDs and the 21 original key aliases produce the same Event_Key values as the Python collector.
- Combines direct city results with Grist's saved city history. Preserves first-seen times, local row IDs and notes; flags changed dates/times and missing future listings. If the city check fails, skips every city event write while saving a failed Source_Checks attempt and allowing the working server feeds to update. The older GitHub city snapshot cannot overwrite newer Grist records. Direct city data stays in Grist and is not uploaded to GitHub.
- Re-reads Grist at write time. Creates required tables/columns in a separate setup transaction, then re-reads and validates the actual schema and keys. Grist forbids combining schema changes with `AddOrUpdateRecord`; version 1.2.1 separates those phases. Changed/new source rows are written in one data-only `applyUserActions` transaction, matching the text key with `on_many: none`. Matching happens in Grist, preventing blind duplicate insertion after a stale preview. If data writes fail after setup, a fresh retry reuses the existing schema.
- Reads Grist again and only reports verified success if the new plan contains no writes. A failure never implies rollback unless Grist confirms it; retry starts with fresh reads.
- Preserves row IDs, extra note/reference/formula columns, all Calendar values, and all sales data. Never deletes rows. Local keys missing from a snapshot are retained and reported.
- Refreshes source-owned event status/metadata and the separate source review notes. Manual changes in other **source-owned** fields are intentionally replaced by the collector on the next sync.
- Shows last-success source checks and stale/failed feeds. A retained `Currently_Listed` flag from a failed source is not evidence of a fresh listing or that an event was held. Multiple listings may describe the same physical event; review flags are retained.
- Warns about event dates absent from Calendar without adding dates or setting future days closed.

The HTML/JS/CSS are public widget code. Venue data remains in the private collector repository. The opt-in remembered token is in this widget origin's local storage on the user's computer; all code hosted on that origin is trusted. It is never stored in document options or committed. Use a read-only token scoped to the event repository and use **Forget token** to clear it.

## Validation

No build or production dependencies. Grist's official plugin API is the only external script.

```sh
node --test tests/event-sync.test.js tests/desktop-sync.test.js
# With Playwright installed:
node tests/browser.test.js
SYNC_BROWSER_DESKTOP=1 node tests/browser.test.js
# Also check the actual official API bundle under the widget's CSP:
curl --fail --location https://docs.getgrist.com/grist-plugin-api.js --output /tmp/grist-plugin-api.js
SYNC_GRIST_API_PATH=/tmp/grist-plugin-api.js node tests/plugin-api.test.js
```

Tests cover CSV quoting/newlines, validation failures, partial sources, date/timestamp/boolean conversions, idempotence, key collisions, preservation of manual data and references, optional checks, failed verification, authenticated snapshot reads, and the browser connection/sync/reopen workflow. Browser tests use synthetic data and a fake read token; they never connect to a real Grist document. A live Grist Desktop connection still needs to be verified on the user's computer.

The separate plugin API regression test executes the freshly downloaded official Grist bundle, rather than replacing it with the document mock. This checks CSP compatibility. The current official bundle uses `eval`, so `script-src` must allow `unsafe-eval`; script origins remain restricted to this widget and docs.getgrist.com. Version 1.0.1 fixes the original policy that blocked that bundle before `window.grist` was created.

Primary API references:
- https://support.getgrist.com/widget-custom/
- https://support.getgrist.com/code/interfaces/grist_plugin_api.GristDocAPI/
- https://github.com/gristlabs/grist-core/blob/main/sandbox/grist/useractions.py (`AddOrUpdateRecord`)
- https://github.com/gristlabs/grist-core/blob/main/documentation/grist-data-format.md
- https://docs.github.com/en/rest/repos/contents#get-repository-content
