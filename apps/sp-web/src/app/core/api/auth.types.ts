export interface AuthStatusResponse {
  bootstrapRequired: boolean;
  authenticated: boolean;
  username: string | null;
  /**
   * Signed out, and Face ID sign-in can work on this site: a passkey has been
   * added for App Lock. Older servers leave it out.
   */
  passkeySignIn?: boolean;
}

export interface BootstrapAdminPayload {
  username: string;
  password: string;
}

export interface LoginPayload {
  username: string;
  password: string;
  /** "Keep me signed in"; the server treats it as on when left out. */
  rememberMe?: boolean;
}

export interface ChangePasswordPayload {
  currentPassword: string;
  newPassword: string;
}
