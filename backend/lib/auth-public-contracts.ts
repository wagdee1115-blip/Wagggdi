export const PASSWORD_RESET_PUBLIC_MESSAGE = 'IF_ACCOUNT_EXISTS_RESET_INSTRUCTIONS_WILL_BE_SENT' as const;

export function passwordResetPublicResponse(recoveryToken: string) {
  return { ok: true, message: PASSWORD_RESET_PUBLIC_MESSAGE, recoveryToken } as const;
}

export const REGISTRATION_DUPLICATE_RESPONSE = { ok: false, error: 'REGISTRATION_UNAVAILABLE' } as const;
