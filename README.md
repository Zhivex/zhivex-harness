# B-lite browser review evidence

Captured from the complete six-item B-lite implementation with the repository's offline browser smoke and system Chromium. These screenshots show the combined series, not an isolated before/after for each PR. All data is synthetic fixture data.

- `web-review-long-lines-390.png`: mobile layout at 390 px.
- `web-review-long-lines-1120.png`: browser layout at 1120 px (not the desktop application).
- `web-review-long-lines-1280.png`: browser layout at 1280 px.
- `web-review-mobile.png`: normal mobile review.

The long-content screenshots deliberately stress visible paths and diff lines in the browser DOM, then restore the original text before continuing the real approval flow. No review ticket or payload is modified.

Local validation: both UI typechecks and builds, web lint, architecture check, complete browser smoke, and 186 desktop unit tests passed (12 platform skips). Web unit tests: 76 passed; the existing unlimited pending-approval restart test timed out after 5000 ms, including an isolated retry. No timeout or assertion was relaxed. Packaged macOS smoke results and desktop screenshots must come from CI; they were not run on the Linux development executor.
