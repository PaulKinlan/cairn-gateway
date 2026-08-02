# M1 browser validation

- **Source commit:** `90808f8030beed074e0fbe04f130c6bb0f5152f5`
- **Date:** 2026-08-02
- **Browser:** Headless Chrome `150.0.7871.24`, reported user agent `HeadlessChrome/150.0.0.0`
- **Harness:** Chrome DevTools MCP, isolated context `cairn-m1-90808-validation`
- **Local route:** `http://127.0.0.1:8793/`
- **Owned server:** PID `2490481`, start ticks `136078312`; bound to loopback only
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
8. Created a replacement grant and observed version `4`, a new expiry, and usage reset to `0 of 5`.

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
  `6e1833979880aae750791bf4c20982666ade485e7e79ee81e9a73df6d77f79f4`
- [Mobile dark](mobile-dark.png) — SHA-256
  `248d274ddddb2a046c444044e89c46f3e138d3503f0f01c31a072845595f6055`
- Lighthouse report SHA-256: `9cffc364d0a890324865c361af022a0ef2e360d968c643002b5a9d7a14730112`
  (private local report; the bounded scores are recorded above)

## Verdict

The independently reviewed M1 partial submilestone is browser-usable and responsive. M1 remains
incomplete because the owner-entered identity values are display labels mapped to the fixed closed
fixture authority rather than genuine cryptographic agent/device enrollment and workload binding.
