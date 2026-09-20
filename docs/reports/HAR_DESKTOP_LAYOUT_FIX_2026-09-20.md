# Desktop credential settings layout regression

The credential settings introduced in b821244 were a third direct child of the
main two-column grid. The browser placed navigation in the second column and
conversation below it in the narrow first column. Functional smoke tests passed
because controls remained in the DOM; they did not measure visible placement.

The fix nests settings inside the existing sidebar and adds scoped spacing and
button styles. Main again has exactly two children. Existing concurrent formatting
changes are preserved outside this fix.

Actual Electron measurements before the fix failed at both 1120px and 720px,
with settings open and closed: content x=0, width=252/190px, y=363/355px.
Afterward all four cases passed: sidebar x=0, content x=252/190px, y=0, content
right equal to viewport width. The 720px/open screenshot was visually inspected;
settings scroll within the sidebar and do not displace conversation or composer.

Reproduce after build with `bun run desktop/scripts/smoke-layout.ts`; add
`--packaged` to load the renderer/preload from the packaged ASAR. The runner uses
a separate Electron window and profile with an empty project bridge fixture; it
does not open projects or access credentials. It tests layout, not live runtime.
Desktop typecheck passed and the unsigned macOS package was rebuilt. No push.
