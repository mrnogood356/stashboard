export interface AuthStatusResponse {
  bootstrapRequired: boolean;
  authenticated: boolean;
  username: string | null;
  /**
   * Signed out, and Face ID sign-in can work on this site: a passkey has been
   * added for App Lock. Older servers leave it out.
   */
  passkeySignIn?: boolean;
  /** No admin yet, and the server's SETUP_CODE is needed to create one. */
  setupCodeRequired?: boolean;
}

export interface BootstrapAdminPayload {
  username: string;
  password: string;
  setupCode?: string;
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
