import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Input } from '../../components/ui/input.js';
import { cn } from '../../lib/utils.js';
import type { ApiClient } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { UserProfile } from './auth-types.js';

type AuthMode = 'login' | 'register' | 'forgot' | 'reset';

export interface AuthModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onSuccess: (user: UserProfile, token: string) => void;
  readonly apiClient: ApiClient;
  readonly initialMode?: 'login' | 'register';
  readonly canClose?: boolean;
  readonly className?: string;
}

export function AuthModal({
  isOpen,
  onClose,
  onSuccess,
  apiClient,
  initialMode = 'login',
  canClose = true,
  className,
}: AuthModalProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [oauthProviders, setOauthProviders] = useState<readonly ('google' | 'github')[]>([]);

  useEffect(() => {
    setMode(initialMode);
    setErrorMessage(null);
    setMessage(null);
    setShowPassword(false);
  }, [initialMode, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    void apiClient
      .getAuthOptions()
      .then((options) => {
        if (active) setOauthProviders(options.oauthProviders);
      })
      .catch(() => {
        if (active) setOauthProviders([]);
      });
    return () => {
      active = false;
    };
  }, [apiClient, isOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen && canClose) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canClose, isOpen, onClose]);

  if (!isOpen) return null;

  const finish = (response: { user: UserProfile; token: string }) => {
    onSuccess(response.user, response.token);
    setName('');
    setEmail('');
    setPassword('');
    setCode('');
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setErrorMessage(null);
    setMessage(null);
    setIsLoading(true);
    try {
      if (mode === 'login') finish(await apiClient.login({ email, password }));
      if (mode === 'register') {
        finish(await apiClient.register({ email, password, name: name.trim() || undefined }));
      }
      if (mode === 'forgot') {
        await apiClient.requestPasswordReset(email);
        setMode('reset');
        setMessage(t('auth.recoverySent'));
      }
      if (mode === 'reset') finish(await apiClient.resetPassword({ email, code, password }));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : t('runtime.authFailure'));
    } finally {
      setIsLoading(false);
    }
  };

  const isPasswordMode = mode === 'login' || mode === 'register' || mode === 'reset';
  const isCodeMode = mode === 'reset';
  const title =
    mode === 'login'
      ? t('runtime.loginWorkspace')
      : mode === 'register'
        ? t('runtime.createUserAccount')
        : t('auth.recoverAccount');
  const subtitle =
    mode === 'login'
      ? t('auth.loginSubtitle')
      : mode === 'register'
        ? t('auth.registerSubtitle')
        : t('auth.recoverySubtitle');

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-[var(--surface-0)]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
      data-testid="auth-modal"
    >
      <div className="relative flex min-h-full items-center justify-center overflow-hidden p-4 sm:p-8">
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <div className="absolute -left-40 -top-52 h-[34rem] w-[34rem] rounded-full bg-[var(--fill-accent)] opacity-[0.08] blur-3xl" />
          <div className="absolute -bottom-64 -right-32 h-[38rem] w-[38rem] rounded-full bg-[var(--fill-pro)] opacity-[0.07] blur-3xl" />
          <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.018)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.018)_1px,transparent_1px)] bg-[size:48px_48px]" />
        </div>
        <div
          className={cn(
            'relative grid w-full max-w-5xl overflow-hidden rounded-2xl border border-[var(--border-strong)] bg-[var(--surface-1)] shadow-2xl shadow-black/50 lg:min-h-[640px] lg:grid-cols-[0.9fr_1.1fr]',
            className,
          )}
        >
          <AuthBrandPanel />
          <section className="relative flex items-center justify-center px-6 py-14 sm:px-12 lg:px-16">
            {canClose && (
              <IconButton
                icon={<i className="ti ti-x text-lg" aria-hidden="true" />}
                label={t('runtime.close')}
                onClick={onClose}
                size="sm"
                className="absolute right-4 top-4 z-10"
              />
            )}
            <div className="w-full max-w-md">
              <div className="mb-8">
                <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--border-accent)] bg-[var(--bg-accent)] text-[var(--text-accent)] lg:hidden">
                  <i className="ti ti-shield-lock text-xl" aria-hidden="true" />
                </div>
                <h2
                  id="auth-modal-title"
                  className="text-2xl font-bold tracking-tight text-[var(--text-primary)] sm:text-3xl"
                >
                  {title}
                </h2>
                <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">{subtitle}</p>
              </div>

              {(mode === 'login' || mode === 'register') && (
                <div className="mb-6 flex rounded-lg border border-border bg-surface-2 p-1">
                  {(['login', 'register'] as const).map((item) => (
                    <Button
                      key={item}
                      type="button"
                      size="sm"
                      variant={mode === item ? 'secondary' : 'ghost'}
                      className="h-9 flex-1 text-xs font-semibold"
                      onClick={() => {
                        setMode(item);
                        setErrorMessage(null);
                      }}
                    >
                      {item === 'login' ? t('auth.submitLogin') : t('runtime.createAccount')}
                    </Button>
                  ))}
                </div>
              )}

              {message && (
                <div
                  className="mb-4 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300"
                  role="status"
                >
                  {message}
                </div>
              )}
              {errorMessage && (
                <div
                  className="mb-4 rounded-md border border-[var(--border-danger)] bg-[var(--bg-danger)] p-3 text-xs text-[var(--text-danger)]"
                  role="alert"
                >
                  {errorMessage}
                </div>
              )}

              <form onSubmit={(event) => void submit(event)} className="space-y-4">
                {mode === 'register' && (
                  <Field label={t('auth.name')} id="auth-name">
                    <Input
                      id="auth-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      autoComplete="name"
                      required
                      leftIcon={<i className="ti ti-user" aria-hidden="true" />}
                      placeholder={t('runtime.fullNameExample')}
                      className="h-12"
                    />
                  </Field>
                )}
                <Field label={t('auth.email')} id="auth-email">
                  <Input
                    id="auth-email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                    required
                    leftIcon={<i className="ti ti-mail" aria-hidden="true" />}
                    placeholder={t('auth.emailPlaceholder')}
                    className="h-12"
                  />
                </Field>
                {isCodeMode && (
                  <Field label={t('auth.verificationCode')} id="auth-code">
                    <Input
                      id="auth-code"
                      inputMode="numeric"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      value={code}
                      onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                      autoComplete="one-time-code"
                      required
                      leftIcon={<i className="ti ti-key" aria-hidden="true" />}
                      placeholder="000000"
                      className="h-12 tracking-[0.3em]"
                    />
                  </Field>
                )}
                {isPasswordMode && (
                  <Field
                    label={mode === 'reset' ? t('auth.newPassword') : t('auth.password')}
                    id="auth-password"
                  >
                    <div className="relative">
                      <Input
                        id="auth-password"
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        minLength={8}
                        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                        required
                        leftIcon={<i className="ti ti-lock" aria-hidden="true" />}
                        placeholder={t('auth.passwordPlaceholder')}
                        className="h-12 pr-12"
                      />
                      <IconButton
                        type="button"
                        size="sm"
                        icon={
                          <i
                            className={showPassword ? 'ti ti-eye-off' : 'ti ti-eye'}
                            aria-hidden="true"
                          />
                        }
                        label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                        onClick={() => setShowPassword((current) => !current)}
                        className="absolute right-2 top-2"
                      />
                    </div>
                  </Field>
                )}
                <Button type="submit" className="mt-3 h-12 w-full" isLoading={isLoading}>
                  {mode === 'login'
                    ? t('runtime.loginPlatform')
                    : mode === 'register'
                      ? t('runtime.createMyAccount')
                      : mode === 'forgot'
                        ? t('auth.recoverAccount')
                        : t('auth.resetPassword')}
                </Button>
              </form>

              {mode === 'login' && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-3 w-full"
                  onClick={() => setMode('forgot')}
                >
                  {t('auth.forgotPassword')}
                </Button>
              )}
              {(mode === 'forgot' || mode === 'reset') && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-1 w-full"
                  onClick={() => setMode('login')}
                >
                  {t('auth.backToLogin')}
                </Button>
              )}

              {(mode === 'login' || mode === 'register') && oauthProviders.length > 0 && (
                <div className="mt-6">
                  <div className="mb-3 flex items-center gap-3 text-xs text-muted">
                    <span className="h-px flex-1 bg-border" />
                    <span>{t('auth.orContinueWith')}</span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                  <div
                    className={cn(
                      'grid gap-2',
                      oauthProviders.length > 1 ? 'grid-cols-2' : 'grid-cols-1',
                    )}
                  >
                    {oauthProviders.includes('google') && (
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => {
                          window.location.href = apiClient.getOAuthStartUrl('google');
                        }}
                      >
                        <i className="ti ti-brand-google" aria-hidden="true" />
                        {t('auth.continueWithGoogle')}
                      </Button>
                    )}
                    {oauthProviders.includes('github') && (
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => {
                          window.location.href = apiClient.getOAuthStartUrl('github');
                        }}
                      >
                        <i className="ti ti-brand-github" aria-hidden="true" />
                        {t('auth.continueWithGithub')}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function AuthBrandPanel() {
  const { t } = useI18n();
  return (
    <aside className="relative hidden overflow-hidden border-r border-[var(--border)] bg-[var(--surface-2)] p-12 lg:flex lg:flex-col">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_15%,rgba(74,143,232,0.22),transparent_38%),radial-gradient(circle_at_80%_85%,rgba(123,97,212,0.18),transparent_42%)]" />
      <div className="relative flex items-center gap-3 text-base font-semibold text-[var(--text-primary)]">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--border-accent)] bg-[var(--bg-accent)] text-[var(--text-accent)]">
          <i className="ti ti-hexagon-letter-a text-xl" aria-hidden="true" />
        </span>
        {t('auth.brandName')}
      </div>
      <div className="relative my-auto py-12">
        <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-[var(--border-accent)] bg-[var(--bg-accent)] px-3 py-1 text-xs font-semibold text-[var(--text-accent)]">
          <i className="ti ti-shield-check" aria-hidden="true" />
          {t('auth.secureAccess')}
        </span>
        <h3 className="max-w-sm text-4xl font-bold leading-tight tracking-tight text-[var(--text-primary)]">
          {t('auth.brandHeadline')}
        </h3>
        <p className="mt-5 max-w-sm text-sm leading-7 text-[var(--text-secondary)]">
          {t('auth.brandDescription')}
        </p>
        <div className="mt-9 flex gap-2" aria-hidden="true">
          <span className="h-1.5 w-12 rounded-full bg-[var(--fill-accent)]" />
          <span className="h-1.5 w-5 rounded-full bg-[var(--fill-pro)]" />
          <span className="h-1.5 w-5 rounded-full bg-[var(--border-strong)]" />
        </div>
      </div>
      <p className="relative text-xs text-[var(--text-muted)]">{t('auth.copyright')}</p>
    </aside>
  );
}

function Field({
  label,
  id,
  children,
}: {
  readonly label: string;
  readonly id: string;
  readonly children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
        {label}
      </label>
      {children}
    </div>
  );
}
