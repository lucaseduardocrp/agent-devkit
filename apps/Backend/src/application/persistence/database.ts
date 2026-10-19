/**
 * Infrastructure port used by the application bootstrap.
 *
 * Feature repositories remain application-level ports and must not expose SQL
 * or driver-specific types. Concrete database adapters implement this port.
 */
export interface DatabaseConnection {
  readonly provider: 'postgres';
  check(): Promise<void>;
  close(): Promise<void>;
}
