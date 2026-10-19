import { useState } from 'react';
import { cn } from '../../lib/utils.js';
import { Input } from '../../components/ui/input.js';
import { Button } from '../../components/ui/button.js';
import { SkeletonCard } from '../../components/ui/skeleton.js';
import { type UserWorkspaceMembership, getRoleBadgeClass } from './workspace-types.js';
import { useI18n, type TranslationKey } from '../../lib/i18n/index.js';

const roleKeys: Record<UserWorkspaceMembership['member']['role'], TranslationKey> = {
  ADMIN: 'workspaces.roleAdmin',
  INTEGRATOR: 'workspaces.roleIntegrator',
  MEMBER: 'workspaces.roleMember',
  VIEWER: 'workspaces.roleViewer',
};

export interface WorkspacesViewProps {
  readonly workspaces: readonly UserWorkspaceMembership[];
  readonly activeWorkspaceId: string | null;
  readonly onSelectWorkspace: (workspaceId: string) => void;
  readonly onCreateWorkspace: (data: { name: string; slug?: string }) => Promise<void>;
  readonly isLoading?: boolean;
  readonly className?: string;
}

export function WorkspacesView({
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onCreateWorkspace,
  isLoading = false,
  className,
}: WorkspacesViewProps) {
  const { t, formatDate } = useI18n();
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceSlug, setWorkspaceSlug] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = workspaceName.trim();
    if (!trimmedName) {
      setErrorMessage(t('workspaces.requiredName'));
      return;
    }
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      const slug = workspaceSlug.trim() || undefined;
      await onCreateWorkspace({ name: trimmedName, slug });
      setWorkspaceName('');
      setWorkspaceSlug('');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t('workspaces.createFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className={cn('mx-auto max-w-5xl space-y-6', className)} data-testid="screen-workspaces">
      <div>
        <h2 className="text-xl font-bold text-[var(--text-primary)]">{t('workspaces.title')}</h2>
        <p className="text-xs text-muted">{t('workspaces.manageDescription')}</p>
      </div>

      {/* Card de Criação */}
      <div className="rounded-xl border border-border bg-surface-1 p-5 shadow-sm">
        <h3 className="mb-1 text-sm font-semibold text-[var(--text-primary)]">
          {t('workspaces.createTitle')}
        </h3>
        <p className="mb-4 text-xs text-muted">{t('workspaces.createDescription')}</p>

        {errorMessage && (
          <div
            className="mb-4 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400"
            role="alert"
          >
            <i className="ti ti-alert-circle text-base" aria-hidden="true" />
            <span>{errorMessage}</span>
          </div>
        )}

        <form
          onSubmit={(e) => {
            void handleCreateSubmit(e);
          }}
          className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end"
        >
          <div>
            <label
              htmlFor="workspace-name-input"
              className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]"
            >
              {t('workspaces.workspaceName')} <span className="text-red-400">*</span>
            </label>
            <Input
              id="workspace-name-input"
              type="text"
              value={workspaceName}
              onChange={(e) => setWorkspaceName(e.target.value)}
              placeholder={t('workspaces.nameExample')}
              disabled={isSubmitting || isLoading}
            />
          </div>

          <div>
            <label
              htmlFor="workspace-slug-input"
              className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]"
            >
              {t('workspaces.slugOptional')}
            </label>
            <Input
              id="workspace-slug-input"
              type="text"
              value={workspaceSlug}
              onChange={(e) => setWorkspaceSlug(e.target.value)}
              placeholder={t('workspaces.slugExample')}
              disabled={isSubmitting || isLoading}
            />
          </div>

          <div className="flex items-end">
            <Button
              type="submit"
              disabled={isSubmitting || isLoading}
              isLoading={isSubmitting}
              className="h-[40px] w-full"
              leftIcon={<i className="ti ti-plus text-sm" aria-hidden="true" />}
            >
              {t('workspaces.createWorkspace')}
            </Button>
          </div>
        </form>
      </div>

      {/* Lista de Workspaces */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            {t('workspaces.yourWorkspaces', { count: workspaces.length })}
          </h3>
        </div>

        {isLoading ? (
          <div
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
            data-testid="workspaces-loading-skeleton"
          >
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        ) : workspaces.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-xs text-muted">
            <i className="ti ti-folders mb-2 text-2xl" aria-hidden="true" />
            <p>{t('workspaces.emptyDescription')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {workspaces.map((m) => {
              const isActive = m.workspace.id === activeWorkspaceId;
              return (
                <div
                  key={m.workspace.id}
                  data-testid={`workspace-card-${m.workspace.id}`}
                  className={cn(
                    'flex flex-col justify-between rounded-xl border p-4 transition-colors',
                    isActive
                      ? 'border-border-accent bg-surface-2 shadow-sm'
                      : 'border-border bg-surface-1 hover:border-border-strong',
                  )}
                >
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <h4 className="truncate font-semibold text-sm text-[var(--text-primary)]">
                        {m.workspace.name}
                      </h4>
                      <span
                        className={cn(
                          'shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none',
                          getRoleBadgeClass(m.member.role),
                        )}
                      >
                        {t(roleKeys[m.member.role])}
                      </span>
                    </div>

                    <div className="text-[11px] text-muted space-y-1">
                      <div>
                        {t('workspaces.slugLabel')}{' '}
                        <span className="font-mono text-[var(--text-secondary)]">
                          {m.workspace.slug}
                        </span>
                      </div>
                      {m.workspace.createdAt && (
                        <div>
                          {t('workspaces.createdOn', { date: formatDate(m.workspace.createdAt) })}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
                    {isActive ? (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-400">
                        <i className="ti ti-circle-check text-sm" aria-hidden="true" />
                        <span>{t('workspaces.activeWorkspace')}</span>
                      </span>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onSelectWorkspace(m.workspace.id)}
                        aria-label={t('workspaces.selectWorkspaceLabel', {
                          name: m.workspace.name,
                        })}
                        leftIcon={
                          <i className="ti ti-switch-horizontal text-xs" aria-hidden="true" />
                        }
                      >
                        {t('workspaces.select')}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
