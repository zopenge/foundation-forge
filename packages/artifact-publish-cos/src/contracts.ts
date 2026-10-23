export interface CosArtifactCredentials {
  readonly secretId: string;
  readonly secretKey: string;
  readonly sessionToken?: string;
}

export interface CosArtifactTransportOptions {
  readonly bucket: string;
  readonly region: string;
  readonly credentials: CosArtifactCredentials;
  readonly endpoint?: string;
}
