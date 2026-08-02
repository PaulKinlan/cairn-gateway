# M1 browser validation

- **Source commit:** `7b1607a5add89b4ff5e3fbdd73a674f6231b59ef`
- **Date:** 2026-08-02
- **Browser:** Headless Chrome `150.0.7871.24`, reported user agent `HeadlessChrome/150.0.0.0`
- **Harness:** Chrome DevTools MCP, isolated context `cairn-m1-7b1607-validation`
- **Local route:** `http://127.0.0.1:8794/`
- **Owned server:** PID `2545042`, start ticks `136189796`; bound to loopback only
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
  `be452e7cbc9c0b88bece08d33a685580a558bbab10c3998cfe48e8914e30b76d`
- [Mobile dark](mobile-dark.png) — SHA-256
  `bb754b69945c911edd49fc87522e0176798e2b63e8e659bb2a561057221262a3`
- Lighthouse report SHA-256: `42f30831899d742485f9e519d0e121b5a1d3711196b01a12f426443c177a5751`
  (private local report; the bounded scores are recorded above)

## Verdict

M1 is browser-usable and responsive. It intentionally uses display labels mapped to the fixed closed
fixture authority; genuine cryptographic agent/device enrollment and workload binding are M3 work
and are not claimed here.
