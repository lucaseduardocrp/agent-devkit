import { Button } from '../../components/ui/button.js';
import { Select } from '../../components/ui/select.js';
import type { AzureDevOpsMemberDto } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';

interface Props {
  areas: readonly string[];
  members: readonly AzureDevOpsMemberDto[];
  states: readonly string[];
  loading: boolean;
  error: boolean;
  area: string;
  assignee: string;
  state: string;
  onArea: (value: string) => void;
  onAssignee: (value: string) => void;
  onState: (value: string) => void;
  onRetry: () => void;
}

export function AzureExportFields({
  areas,
  members,
  states,
  loading,
  error,
  area,
  assignee,
  state,
  onArea,
  onAssignee,
  onState,
  onRetry,
}: Props) {
  const { t } = useI18n();
  const fields = [
    {
      label: 'Area Path',
      value: area,
      change: onArea,
      options: areas.map((path) => ({ value: path, label: path })),
    },
    {
      label: 'Assigned To',
      value: assignee,
      change: onAssignee,
      options: members.map((member) => ({
        value: member.email ? `${member.displayName} <${member.email}>` : member.displayName,
        label: member.email ? `${member.displayName} (${member.email})` : member.displayName,
      })),
    },
    {
      label: 'State',
      value: state,
      change: onState,
      options: states.map((name) => ({ value: name, label: name })),
    },
  ];
  return (
    <div className="space-y-3" aria-busy={loading}>
      {fields.map((field) => (
        <label key={field.label} className="block space-y-1 text-sm">
          <span>{field.label}</span>
          <Select
            aria-label={field.label}
            value={field.value}
            disabled={loading || !field.options.length}
            onChange={(event) => field.change(event.target.value)}
          >
            <option value="">
              {loading
                ? t('testplans.loadingAzureOptions')
                : field.options.length
                  ? t('common.selectOption')
                  : t('testplans.noAzureOptions')}
            </option>
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
      ))}
      {error && (
        <p role="alert" className="text-sm text-muted">
          {t('testplans.azureOptionsFailed')}
        </p>
      )}
      {error && (
        <Button variant="ghost" size="sm" onClick={onRetry}>
          {t('testplans.reloadAzureOptions')}
        </Button>
      )}
    </div>
  );
}
