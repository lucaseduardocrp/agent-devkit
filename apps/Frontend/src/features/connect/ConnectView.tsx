import { useState, useEffect, type KeyboardEvent } from 'react';
import { cn } from '../../lib/utils.js';
import type { ApiClient, IntegrationCategory, UserIntegrationDto } from '../../lib/api-client.js';
import { IntegrationConfigModal, type IntegrationCardItem } from './IntegrationConfigModal.js';
import { SkeletonCard } from '../../components/ui/skeleton.js';
import { Button } from '../../components/ui/button.js';
import { useI18n, type TranslationKey } from '../../lib/i18n/index.js';

export interface ConnectViewProps {
  readonly apiClient?: ApiClient;
  readonly isAuthenticated?: boolean;
  readonly onRequireAuth?: () => void;
  readonly canManageIntegrations?: boolean;
  readonly isLoading?: boolean;
  readonly className?: string;
}

const defaultIntegrations: readonly IntegrationCardItem[] = [
  {
    id: 'azure',
    providerId: 'azure_devops_wiki',
    category: 'KNOWLEDGE',
    name: 'Azure DevOps',
    desc: '',
    descriptionKey: 'connect.azureDescription',
    icon: 'ti-brand-azure',
    iconBg: 'var(--bg-accent)',
    iconColor: 'var(--text-accent)',
    status: 'connected',
  },
  {
    id: 'github',
    providerId: 'github_projects',
    category: 'PROJECT_MANAGEMENT',
    name: 'GitHub',
    desc: '',
    descriptionKey: 'connect.githubDescription',
    icon: 'ti-brand-github',
    iconBg: 'var(--bg-pro)',
    iconColor: 'var(--text-pro)',
    status: 'disconnected',
  },
  {
    id: 'trello',
    providerId: 'trello',
    category: 'PROJECT_MANAGEMENT',
    name: 'Trello',
    desc: 'Listas e cards do Trello',
    icon: 'ti-brand-trello',
    iconBg: 'var(--bg-accent)',
    iconColor: 'var(--text-accent)',
    status: 'not-configured',
  },
  {
    id: 'jira',
    providerId: 'jira',
    category: 'PROJECT_MANAGEMENT',
    name: 'Jira',
    desc: 'Epics e issues do Jira Cloud',
    icon: 'ti-ticket',
    iconBg: 'var(--bg-accent)',
    iconColor: 'var(--text-accent)',
    status: 'not-configured',
  },
  {
    id: 'testrail',
    providerId: 'testrail',
    category: 'PROJECT_MANAGEMENT',
    name: 'TestRail',
    desc: '',
    descriptionKey: 'connect.testrailDescription',
    icon: 'ti-checklist',
    iconBg: 'var(--bg-success)',
    iconColor: 'var(--text-success)',
    status: 'not-configured',
  },
  {
    id: 'xray',
    providerId: 'xray',
    category: 'PROJECT_MANAGEMENT',
    name: 'Xray Cloud',
    desc: '',
    descriptionKey: 'connect.xrayDescription',
    icon: 'ti-test-pipe',
    iconBg: 'var(--bg-success)',
    iconColor: 'var(--text-success)',
    status: 'not-configured',
  },
  {
    id: 'wiki-js',
    providerId: 'wiki_js',
    category: 'KNOWLEDGE',
    name: 'Wiki.js',
    desc: '',
    descriptionKey: 'connect.wikiDescription',
    icon: 'ti-book',
    iconBg: 'var(--bg-accent)',
    iconColor: 'var(--text-accent)',
    status: 'not-configured',
  },
  {
    id: 'gemini',
    providerId: 'gemini',
    category: 'LLM',
    name: 'Google Gemini',
    desc: '',
    descriptionKey: 'connect.geminiDescription',
    icon: 'ti-sparkles',
    iconBg: 'var(--bg-warning)',
    iconColor: 'var(--text-warning)',
    status: 'not-configured',
  },
  {
    id: 'openai',
    providerId: 'openai',
    category: 'LLM',
    name: 'OpenAI',
    desc: '',
    descriptionKey: 'connect.openaiDescription',
    icon: 'ti-brand-openai',
    iconBg: 'var(--surface-0)',
    iconColor: 'var(--text-primary)',
    status: 'not-configured',
  },
  {
    id: 'claude',
    providerId: 'claude',
    category: 'LLM',
    name: 'Anthropic Claude',
    desc: '',
    descriptionKey: 'connect.claudeDescription',
    icon: 'ti-message-chatbot',
    iconBg: 'var(--bg-warning)',
    iconColor: 'var(--text-warning)',
    status: 'not-configured',
  },
  {
    id: 'groq',
    providerId: 'groq',
    category: 'LLM',
    name: 'Groq',
    desc: '',
    descriptionKey: 'connect.groqDescription',
    icon: 'ti-bolt',
    iconBg: 'var(--bg-danger)',
    iconColor: 'var(--text-danger)',
    status: 'not-configured',
  },
  {
    id: 'ollama',
    providerId: 'ollama',
    category: 'LLM',
    name: 'Ollama',
    desc: '',
    descriptionKey: 'connect.ollamaDescription',
    icon: 'ti-cpu',
    iconBg: 'var(--surface-0)',
    iconColor: 'var(--text-primary)',
    status: 'not-configured',
  },
];

type IntegrationFilter = 'ALL' | 'KNOWLEDGE' | 'LLM' | 'PROJECT_MANAGEMENT';

const integrationSections: readonly {
  id: Exclude<IntegrationFilter, 'ALL'>;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
  icon: string;
}[] = [
  {
    id: 'KNOWLEDGE',
    labelKey: 'connect.knowledgeCategory',
    descriptionKey: 'connect.knowledgeDescription',
    icon: 'ti-books',
  },
  {
    id: 'LLM',
    labelKey: 'connect.aiCategory',
    descriptionKey: 'connect.aiDescription',
    icon: 'ti-sparkles',
  },
  {
    id: 'PROJECT_MANAGEMENT',
    labelKey: 'connect.projectsCategory',
    descriptionKey: 'connect.projectsDescription',
    icon: 'ti-layout-kanban',
  },
];

export function ConnectView({
  apiClient,
  isAuthenticated = true,
  onRequireAuth,
  canManageIntegrations = true,
  isLoading: isLoadingProp,
  className,
}: ConnectViewProps = {}) {
  const { t } = useI18n();
  const [integrations, setIntegrations] =
    useState<readonly IntegrationCardItem[]>(defaultIntegrations);
  const [savedConfigs, setSavedConfigs] = useState<Record<string, UserIntegrationDto>>({});
  const [activeModalItem, setActiveModalItem] = useState<IntegrationCardItem | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(isLoadingProp ?? false);
  const [activeFilter, setActiveFilter] = useState<IntegrationFilter>('ALL');

  useEffect(() => {
    let isMounted = true;
    if (!apiClient) return;

    void apiClient
      .getIntegrations()
      .then((configs) => {
        if (!isMounted) return;
        const map: Record<string, UserIntegrationDto> = {};
        configs.forEach((cfg) => {
          map[`${cfg.category}:${cfg.providerId}`] = cfg;
        });
        setSavedConfigs(map);

        setIntegrations((prev) =>
          prev.map((item) => {
            const saved = map[`${item.category}:${item.providerId}`];
            if (!saved) {
              return { ...item, status: 'not-configured', hasSecret: false };
            }
            return {
              ...item,
              status: saved.isEnabled ? 'connected' : 'disconnected',
              hasSecret: saved.hasSecret,
            };
          }),
        );
      })
      .catch(() => {
        // Fallback to default integrations if unauthenticated or offline
      })
      .finally(() => {
        if (isMounted) {
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [apiClient]);

  const handleCardClick = (item: IntegrationCardItem) => {
    if (!apiClient) {
      // Offline / standalone toggle behavior
      setIntegrations((prev) =>
        prev.map((it) => {
          if (it.id !== item.id) return it;
          const nextStatus = it.status === 'connected' ? 'disconnected' : 'connected';
          return { ...it, status: nextStatus };
        }),
      );
      return;
    }

    if (!isAuthenticated && onRequireAuth) {
      onRequireAuth();
      return;
    }

    setActiveModalItem(item);
  };

  const handleSaveSuccess = (saved: UserIntegrationDto) => {
    const key = `${saved.category}:${saved.providerId}`;
    setSavedConfigs((prev) => ({ ...prev, [key]: saved }));
    setIntegrations((prev) =>
      prev.map((it) => {
        if (it.category === saved.category && it.providerId === saved.providerId) {
          return {
            ...it,
            status: saved.isEnabled ? 'connected' : 'disconnected',
            hasSecret: saved.hasSecret,
          };
        }
        return it;
      }),
    );
  };

  const handleDeleteSuccess = (category: IntegrationCategory, providerId: string) => {
    const key = `${category}:${providerId}`;
    setSavedConfigs((prev) => {
      const copy = { ...prev };
      delete copy[key];
      return copy;
    });
    setIntegrations((prev) =>
      prev.map((it) => {
        if (it.category === category && it.providerId === providerId) {
          return { ...it, status: 'not-configured', hasSecret: false };
        }
        return it;
      }),
    );
  };

  return (
    <div className={cn('space-y-4', className)} data-testid="screen-connect">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted">{t('connect.description')}</div>
      </div>

      <div
        className="flex flex-wrap gap-2 border-b border-border pb-3"
        role="tablist"
        aria-label={t('connect.filterCategories')}
      >
        {[
          { id: 'ALL' as const, label: t('connect.allCategories') },
          ...integrationSections.map(({ id, labelKey }) => ({ id, label: t(labelKey) })),
        ].map((filter) => {
          const count =
            filter.id === 'ALL'
              ? integrations.length
              : integrations.filter((item) => (item.displayCategory ?? item.category) === filter.id)
                  .length;
          const isActive = activeFilter === filter.id;
          return (
            <Button
              key={filter.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              variant={isActive ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setActiveFilter(filter.id)}
              data-testid={`integration-filter-${filter.id.toLowerCase()}`}
              className="h-9"
            >
              {filter.label}
              <span
                className="rounded-full bg-black/15 px-1.5 py-0.5 text-[10px]"
                aria-hidden="true"
              >
                {count}
              </span>
            </Button>
          );
        })}
      </div>

      {(isLoadingProp ?? isLoading) ? (
        <div
          className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3"
          data-testid="integrations-loading-skeleton"
        >
          {Array.from({ length: 6 }).map((_, idx) => (
            <SkeletonCard key={`skel-card-${idx}`} />
          ))}
        </div>
      ) : (
        <div className="space-y-7">
          {integrationSections
            .filter((section) => activeFilter === 'ALL' || section.id === activeFilter)
            .map((section) => (
              <section key={section.id} aria-labelledby={`integration-section-${section.id}`}>
                <div className="mb-3 flex items-start gap-2.5">
                  <i
                    className={`ti ${section.icon} mt-0.5 text-base text-[var(--text-accent)]`}
                    aria-hidden="true"
                  />
                  <div>
                    <h2
                      id={`integration-section-${section.id}`}
                      className="text-sm font-semibold text-[var(--text-primary)]"
                    >
                      {t(section.labelKey)}
                    </h2>
                    <p className="text-xs text-muted">{t(section.descriptionKey)}</p>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3">
                  {integrations
                    .filter((item) => (item.displayCategory ?? item.category) === section.id)
                    .map((item) => (
                      <IntegrationCard
                        key={item.id}
                        item={{
                          ...item,
                          desc: item.descriptionKey ? t(item.descriptionKey) : item.desc,
                        }}
                        onClick={canManageIntegrations ? handleCardClick : undefined}
                      />
                    ))}
                </div>
              </section>
            ))}
        </div>
      )}

      {activeModalItem && canManageIntegrations && (
        <IntegrationConfigModal
          isOpen={true}
          onClose={() => setActiveModalItem(null)}
          integration={{
            ...activeModalItem,
            desc: activeModalItem.descriptionKey
              ? t(activeModalItem.descriptionKey)
              : activeModalItem.desc,
          }}
          currentConfig={savedConfigs[`${activeModalItem.category}:${activeModalItem.providerId}`]}
          apiClient={apiClient}
          onSaveSuccess={handleSaveSuccess}
          onDeleteSuccess={handleDeleteSuccess}
        />
      )}
    </div>
  );
}

/** Without `onClick` the card is a read-only status tile: no button role, focus or handlers. */
function IntegrationCard({
  item,
  onClick,
}: {
  readonly item: IntegrationCardItem;
  readonly onClick?: (item: IntegrationCardItem) => void;
}) {
  const { t } = useI18n();
  const isConnected = item.status === 'connected';
  const statusLabel =
    item.status === 'connected'
      ? t('connect.connected')
      : item.status === 'disconnected'
        ? t('connect.disconnected')
        : t('connect.notConfigured');
  const interaction = onClick
    ? {
        onClick: () => onClick(item),
        onKeyDown: (event: KeyboardEvent) => event.key === 'Enter' && onClick(item),
        tabIndex: 0,
        role: 'button',
        'aria-label': `${item.name}: ${statusLabel}`,
      }
    : {};
  return (
    <div
      className={cn(
        'flex select-none flex-col gap-2 rounded-xl border bg-surface-2 p-3.5 focus:outline-none focus:ring-1 focus:ring-border-accent',
        onClick && 'cursor-pointer',
        isConnected ? 'connected border-border-success' : 'border-border',
      )}
      {...interaction}
      data-testid={`conn-card-${item.id}`}
    >
      <div className="flex items-center gap-2">
        <div
          className="flex h-8 w-8 items-center justify-center rounded text-base"
          style={{ background: item.iconBg }}
        >
          <i className={`ti ${item.icon}`} style={{ color: item.iconColor }} aria-hidden="true" />
        </div>
        <span className="text-[13px] font-semibold text-[var(--text-primary)]">{item.name}</span>
        {item.hasSecret && (
          <i
            className="ti ti-lock ml-auto text-xs text-muted"
            title={t('connect.encryptedCredentials')}
            aria-label={t('connect.encryptedCredentials')}
          />
        )}
      </div>
      <div className="text-[11px] leading-relaxed text-muted">{item.desc}</div>
      <div className="mt-auto flex items-center gap-1.5 pt-1 text-[11px]">
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            isConnected ? 'bg-success' : 'bg-border-strong',
          )}
        />
        <span className={cn('text-[11px]', isConnected ? 'text-success-foreground' : 'text-muted')}>
          {statusLabel}
        </span>
      </div>
    </div>
  );
}
