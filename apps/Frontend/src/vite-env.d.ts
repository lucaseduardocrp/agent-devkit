/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Base URL of the deployed backend API (e.g. the Railway service URL).
   * Unset in local development, where ApiClient falls back to
   * http://localhost:3000 and Vite's dev proxy forwards API requests.
   */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
