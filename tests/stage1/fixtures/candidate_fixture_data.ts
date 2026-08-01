export interface Owner {
  tenantId: string;
  userId: string;
}

export const FIXTURE_JWKS = Object.freeze({
  agent: Object.freeze({
    kty: "EC",
    alg: "ES256",
    crv: "P-256",
    x: "smR81eDQGkVPuYJcufYvW1Yor4zmOiS22czW_605nLI",
    y: "-G0dUjsvMTzltLbJaRQ5YAC7RRB02rficYoaZuk2E2k",
    key_ops: ["verify"],
    ext: true,
  }),
  admin: Object.freeze({
    kty: "EC",
    alg: "ES256",
    crv: "P-256",
    x: "O2CCyYFJGUhn0M0vWjasdumjymVKtR73fCFmb55vRdA",
    y: "uMUV0nmJtolTJhtOF9cR-vg6SqfSnGKYPktqLbh_Bak",
    key_ops: ["verify"],
    ext: true,
  }),
  candidate: Object.freeze({
    kty: "EC",
    alg: "ES256",
    crv: "P-256",
    x: "riuzamRYdtSsBXcbMkj8reFsBat704-Y0hUDIhKN8M0",
    y: "xf_GalyxAhUgPZgYteWGQweU72w5bx0XtHj6nTfj-dg",
    key_ops: ["verify"],
    ext: true,
  }),
});

export const FIXTURE_THUMBPRINTS = Object.freeze({
  agent: "Y2JByOYYapnG4-6IpR07jE184Q7v7-XkpUM78AtH4_g",
  admin: "KQcirNdlXVyUin7Cq9Vand5XTHLB-XcgTeJ303roIsk",
  candidate: "F8aX41Sa7fIy6GlmBc5dsnLUpaohj_YEgM_e3-usZSM",
});
