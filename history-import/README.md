# FDR History Import

This candidate custom widget loads a reviewed local history package into the existing `Daily_Sales` and `Imports` tables. It does not use the file-import wizard or create temporary import tables. Actual Grist Desktop speed has not been measured.

The package stays on the user's computer. It is read locally and its verified records are sent to the attached Grist document through the official widget API. No sales files, credentials or private fixtures belong in this public repository. The widget has no network data fetches, analytics or automatic import. Its API bundle comes from Grist's official site.

Before each write it checks package integrity, exact field names, dates, amounts, totals, duplicate keys, original CSV row controls, unknown fields, existing item references, existing column types, the checked source-register baseline, overlapping import periods and calendar evidence of existing sales. Both record actions run together through Grist. Stable keys and `update:false` prevent changing existing records. It writes only the prepared sales fields and one source registration. Formulas, mappings, calendar notes, overrides and closures remain owned by Grist.

The client requires the server to report all expected new IDs and checks the saved source log and every daily net total. Missing dates must retain their unresolved review and blank sales total. If a write fails, times out or has an unexpected result, the widget does not retry automatically. Recheck the saved Grist file before any recovery. An already imported source or an occupied date window is blocked, including after reopening the page.

The baseline check uses the existing source registrations, not an independent recount of the full sales table. A separate read-only snapshot check remains required after the first real import. Client checks are not an access-control boundary. The user must use the package prepared for this DSR and avoid concurrent edits/imports during the run.

For setup, add a Custom widget in the current DSR, backed by the existing one-row `Trend_Controls` table. After this change is approved and published, its URL is `https://brewedthirsty-bot.github.io/grist-account-yoy-sync/history-import/`. Grant Full document access. Do not replace the existing Event Sync page or use the normal file-import dialog for JSON packages.

Run the source-only tests with `node --test history-import/test.mjs`. Tests use synthetic records only. A successful test suite is not a Grist Desktop performance benchmark.

The upsert option names and return values follow Grist Core v1.7.22 `sandbox/grist/useractions.py`. The API contract is documented at https://support.getgrist.com/code/interfaces/grist_plugin_api.GristDocAPI/.
