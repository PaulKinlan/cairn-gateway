# R1 owner UI: Modern Web Guidance

- **Catalog:** `modern-web-guidance@0.0.172`
- **Search:** `server rendered semantic HTML forms accessible status navigation`
- **Retrieved:** `forms`, `accessibility`, and `html` before changing HTML/client code.

## Guidance applied

- Use server-rendered semantic landmarks and heading order; navigation is a labelled `<nav>` and
  views are real links.
- Use native `<form method="post" action="…">` and `<button type="submit">` controls for every
  mutation; do not recreate controls with generic elements.
- Give every status a textual label and use tables with captions/headers for connection, client,
  grant, and receipt facts.
- Keep visible focus indicators, native keyboard behavior, `lang`, responsive layout, and no
  third-party client script.
- Group destructive actions with explicit impact copy and actionable button labels.

The executable slice adds no text-entry control. CSRF is a hidden server-issued field and tenant is
absent from every form.
