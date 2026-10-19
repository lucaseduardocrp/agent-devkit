import { decryptSecret, encryptSecret } from '../../../shared/encryption.js';
import { ApplicationError } from '../../../shared/errors.js';
import type { AccessServiceToken } from './access-routing.js';

export {
  accessHeaders,
  isLocalGatewayToken,
  isLoopbackRequest,
  localGatewayUrl,
  type AccessServiceToken,
} from './access-routing.js';

export function encryptAccessToken(
  clientId: string | undefined,
  clientSecret: string | undefined,
  baseUrl: string,
): string | null {
  if (!clientId && !clientSecret) return null;
  if (!clientId?.trim() || !clientSecret?.trim() || new URL(baseUrl).protocol !== 'https:')
    throw new ApplicationError(
      'E2E_INVALID_ACCESS_TOKEN',
      'Tunnel authentication requires both access fields and a public HTTPS target.',
      400,
    );
  if (/[\r\n\0]/.test(clientId + clientSecret))
    throw new ApplicationError(
      'E2E_INVALID_ACCESS_TOKEN',
      'The service token contains invalid characters.',
      400,
    );
  return encryptSecret(
    JSON.stringify({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }),
  );
}

export function decryptAccessToken(value: string | null | undefined): AccessServiceToken | null {
  if (!value) return null;
  return JSON.parse(decryptSecret(value)) as AccessServiceToken;
}
