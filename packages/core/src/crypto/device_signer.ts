export interface DeviceSigner {
  readonly deviceId: string;
  publicJwk(): Promise<JsonWebKey>;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export interface DeviceKeyCustody {
  create(label: string): Promise<DeviceSigner>;
  load(deviceId: string): Promise<DeviceSigner | undefined>;
}

export interface PasskeyAuthenticator {
  authenticatePrincipal(
    challenge: Uint8Array,
  ): Promise<{ publicKeyId: string; signature: Uint8Array }>;
}

export interface RecoveryCoordinator {
  beginHumanReviewedRecovery(principalId: string): Promise<{ opaqueHandle: string }>;
}
