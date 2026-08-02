# M1 browser validation

- **Source commit:** `0e5a584bda425ce37271354be664de1826f9faca`
- **Date:** 2026-08-02
- **Browser:** Headless Chrome `150.0.7871.24`, reported user agent `HeadlessChrome/150.0.0.0`
- **Harness:** Chrome DevTools MCP, isolated context `cairn-m1-0e5a584-validation`
- **Local route:** `http://127.0.0.1:8795/`
- **Owned server:** PID `2561374`, start ticks `136240272`; bound to loopback only
- **Browser ownership:** this validation opened and later closed one isolated MCP page. It did not
  launch or own the shared MCP Chrome process or profile, so it did not terminate either.

## Visible journey

The browser exercised the rendered controls rather than calling mutation routes directly:

1. Created the fixture owner.
2. Entered the agent label with the keyboard and submitted with `Tab` then `Enter`.
3. Entered distinct device and workload labels with the keyboard and submitted with `Tab` then
   `Enter`.
4. Created the five-call, 24-hour `github.user.read@v1` grant.
5. Invoked the fixture operation and observed the projected GitHub user, an allow receipt, and usage
   `1 of 5`.
6. Revoked the grant and observed version `2` plus the sanitized audit event.
7. Used **Test denied call** and observed `grant_inactive`, zero request units, and measured denial
   in `0.3 ms`.
8. Created a replacement grant, invoked it through the visible control, and observed version `4`, a
   new expiry, an allow receipt, and usage `1 of 5`.
9. From the same browser origin, completed the Streamable HTTP initialize → initialized → search →
   describe → connection status → invoke sequence, initialized a distinct second session, and
   invoked again without rebuilding authority. Both calls returned the fixed projected user and
   allow receipt; the refreshed UI showed two MCP receipts and replacement usage `3 of 5`.

Chrome initially sends `Origin: null` for the loopback form navigation. The corrected handler
accepted it only with exact loopback host, same-origin Fetch Metadata, POST form navigation, live
admin session, exact form fields, and matching CSRF token. The first visible owner action completed
successfully.

## Rendering and accessibility

- Desktop light: `1280 × 900`, no horizontal overflow, clean console.
- Mobile dark: `390 × 844 @2x`, no horizontal overflow, CLS `0`.
- Lighthouse mobile navigation: Accessibility `100`, Best Practices `100`, SEO `100`, Agentic
  Browsing `100`; 47 passed, 0 failed.
- Keyboard interaction covered both text-entry onboarding forms and form submission.

## Evidence

- [Desktop light](desktop-light.png) — SHA-256
  `2e2eb6ea56c62c227e44e44e8c59ef9848bb213da166ed279620184504c36e3b`
- [Mobile dark](mobile-dark.png) — SHA-256
  `9a3f18f10ec2354d91126df4bac657022a21cfe601fb88f42d62ac06a11665f1`
- Lighthouse report SHA-256: `2e4d344c26738fab08599767176d8dfc846297605bb7157c63025dfcbe8b4629`
  (private local report; the bounded scores are recorded above)

## Verdict

M1 is browser-usable and responsive. It intentionally uses display labels mapped to the fixed closed
fixture authority; genuine cryptographic agent/device enrollment and workload binding are M3 work
and are not claimed here.
