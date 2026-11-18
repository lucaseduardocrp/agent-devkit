import { useEffect, useState, type FormEvent } from 'react';
import type {
  ApiClient,
  E2eCaseRevision,
  E2eCaseTurn,
  SavedTestPlanDto,
} from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import { usePermissions } from '../workspaces/permissions.js';
import { Button } from '../../components/ui/button.js';
import { HelpTooltip } from '../../components/ui/help-tooltip.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { TestCaseModal } from '../testplans/TestCaseModal.js';
import type { TestCase } from '../testplans/TestPlansView.js';
import { E2eSavedCasePicker, EMPTY_SAVED_SELECTION } from './E2eSavedCasePicker.js';
import { errorMessage } from './E2eTestManagement.js';
import type { E2eSavedCaseLink, E2eTestDetail } from './e2e-types.js';

interface PickedCase {
  readonly planId: string;
  readonly caseId: string;
}

interface FoundCase {
  readonly plan: SavedTestPlanDto;
  readonly index: number;
  readonly item: SavedTestPlanDto['plans'][number];
  readonly caseId: string;
}

/** The case of a Test Plan by its stable id; null when the plan no longer has it. */
function findCase(plan: SavedTestPlanDto, caseId: string): FoundCase | null {
  const index = plan.plans.findIndex((item) => item.metadata?.['caseId'] === caseId);
  const item = plan.plans[index];
  return item ? { plan, index, item, caseId } : null;
}

/** Writes the case into its Test Plan and gives back the plan as saved. */
function saveCaseInPlan(
  apiClient: ApiClient,
  { plan, item }: FoundCase,
  updated: TestCase,
): Promise<SavedTestPlanDto> {
  return apiClient.updateSavedTestPlan(plan.id, {
    title: plan.title,
    plans: plan.plans.map((candidate) =>
      candidate === item
        ? {
            title: updated.title,
            description: updated.scenario,
            steps: updated.steps ? [...updated.steps] : [],
            metadata: updated.metadata ?? item.metadata,
          }
        : candidate,
    ),
    ...(plan.suiteId ? { suiteId: plan.suiteId } : {}),
  });
}

/**
 * State shared by the pieces of a test's ADK test case: the "Test case do ADK" section and the
 * edit button in the description header. The plan is read once; editing the case saves it in
 * its Test Plan, which carries the change to this test.
 */
export function useSavedCaseLink(
  apiClient: ApiClient,
  testId: string,
  link: E2eSavedCaseLink | null | undefined,
  onChanged: (test: E2eTestDetail) => void,
) {
  const { t } = useI18n();
  const [plan, setPlan] = useState<SavedTestPlanDto | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const planId = link?.planId;
  const caseId = link?.caseId;

  useEffect(() => {
    setPlan(null);
    setUnavailable(false);
    if (!planId) return;
    let active = true;
    void apiClient.getSavedTestPlan(planId).then(
      (loaded) => {
        if (active) setPlan(loaded);
      },
      () => {
        if (active) setUnavailable(true);
      },
    );
    return () => {
      active = false;
    };
  }, [apiClient, planId]);

  const found = caseId && plan ? findCase(plan, caseId) : null;
  const missing = unavailable || (plan !== null && !found);

  /** Runs a change of the link; true when it went through. */
  const run = async (action: () => Promise<E2eTestDetail>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      onChanged(await action());
      return true;
    } catch (reason) {
      setError(errorMessage(reason, t('e2e.savedCaseLinkFailed')));
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** Saves the case in its Test Plan, which carries the change to this test. */
  const savePlanCase = (target: FoundCase, updated: TestCase) =>
    saveCaseInPlan(apiClient, target, updated).then((next) => {
      setPlan(next);
      setEditing(false);
    });

  const saveCase = async (target: FoundCase, updated: TestCase) => {
    await run(async () => {
      await savePlanCase(target, updated);
      // The plan's save already carried the change to this test; read it back.
      return apiClient.getE2eTest(testId);
    });
  };

  /**
   * "Fix with AI": saves the case the chat left and writes the test script again from it alone
   * (not from the script that followed the wrong flow). A failure to save reaches the editor,
   * which is still open; a failure to start the rewrite shows on the page, where the case is
   * already saved.
   */
  const saveAndRegenerate = async (target: FoundCase, updated: TestCase) => {
    await savePlanCase(target, updated);
    await run(async () => {
      await apiClient.rerunE2eTest(testId, true, { useLastRun: false });
      return apiClient.getE2eTest(testId);
    });
  };

  const askToFix = (turn: E2eCaseTurn): Promise<E2eCaseRevision> =>
    apiClient.reviseE2eTestCase(testId, turn);

  return {
    found,
    missing,
    editing,
    setEditing,
    busy,
    error,
    run,
    saveCase,
    saveAndRegenerate,
    askToFix,
  };
}

export type SavedCaseLink = ReturnType<typeof useSavedCaseLink>;

/** Edit button for the header of the description; the case opens in the Test Plans editor. */
export function E2eEditSavedCase({
  saved,
  isReadOnly,
  disabled,
}: {
  readonly saved: SavedCaseLink;
  readonly isReadOnly: boolean;
  readonly disabled: boolean;
}) {
  const { t } = useI18n();
  const canEditCase = usePermissions().can('testplans', 'edit');
  const { found } = saved;
  if (!found) return null;
  return (
    <>
      {!isReadOnly && canEditCase && (
        <Button
          variant="secondary"
          size="sm"
          disabled={saved.busy || disabled}
          onClick={() => saved.setEditing(true)}
        >
          <i className="ti ti-pencil" aria-hidden="true" />
          {t('e2e.savedCaseEdit')}
        </Button>
      )}
      {saved.editing && (
        <TestCaseModal
          testCase={{
            id: `CT-${String(found.index + 1).padStart(2, '0')}`,
            caseId: found.caseId,
            title: found.item.title,
            scenario: found.item.description,
            steps: found.item.steps,
            metadata: found.item.metadata,
          }}
          planTitle={found.plan.title}
          isSaving={saved.busy}
          onClose={() => saved.setEditing(false)}
          onSave={(updated) => void saved.saveCase(found, updated)}
          fixWithAi={{
            ask: saved.askToFix,
            saveAndRegenerate: (updated) => saved.saveAndRegenerate(found, updated),
          }}
        />
      )}
    </>
  );
}

/**
 * The test case saved in ADK (Test Plans) a test is linked to. The test takes its title,
 * description and steps from it; link or unlink it here, edit it from the description.
 */
export function E2eLinkedSavedCase({
  apiClient,
  test,
  saved,
  isReadOnly,
  disabled,
}: {
  readonly apiClient: ApiClient;
  readonly test: E2eTestDetail;
  readonly saved: SavedCaseLink;
  readonly isReadOnly: boolean;
  readonly disabled: boolean;
}) {
  const { t } = useI18n();
  const canEditCase = usePermissions().can('testplans', 'edit');
  const link = test.savedCase ?? null;
  const [linking, setLinking] = useState(false);
  const [selection, setSelection] = useState(EMPTY_SAVED_SELECTION);
  const [picked, setPicked] = useState<PickedCase | null>(null);
  const { found, missing, busy, error } = saved;

  const submitLink = async (event: FormEvent) => {
    event.preventDefault();
    if (!picked) return;
    if (await saved.run(() => apiClient.linkE2eTestSavedCase(test.id, picked))) {
      setLinking(false);
      setPicked(null);
      setSelection(EMPTY_SAVED_SELECTION);
    }
  };

  const unlink = (
    <Button
      variant="secondary"
      size="sm"
      className="w-fit"
      disabled={busy || disabled}
      onClick={() => void saved.run(() => apiClient.linkE2eTestSavedCase(test.id, null))}
    >
      <i className="ti ti-unlink" aria-hidden="true" />
      {t('e2e.savedCaseUnlink')}
    </Button>
  );

  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="e2e-linked-saved-case">
      {link ? (
        missing ? (
          <>
            <p className="text-amber-300" role="status">
              {t('e2e.savedCaseMissing')}
            </p>
            {!isReadOnly && <div className="flex">{unlink}</div>}
          </>
        ) : !found ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <>
            <p className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-sm text-[var(--text-muted)]">
                {found.plan.title}
                <HelpTooltip align="end" size="md">
                  {t('e2e.savedCaseHint')}
                </HelpTooltip>
              </span>
              <span className="text-[var(--text-primary)]">{found.item.title}</span>
            </p>
            {!isReadOnly && <div className="flex">{unlink}</div>}
          </>
        )
      ) : linking ? (
        <form className="flex flex-col gap-2" onSubmit={(event) => void submitLink(event)}>
          <E2eSavedCasePicker
            apiClient={apiClient}
            value={selection}
            single
            onChange={(next) => {
              setSelection(next);
              // Changing the suite or plan clears the pick.
              if (!next.caseIds?.length) setPicked(null);
            }}
            onPickCase={setPicked}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" isLoading={busy} disabled={busy || !picked}>
              {t('e2e.tmLink')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setLinking(false)}>
              {t('e2e.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p className="text-[var(--text-muted)]">{t('e2e.savedCaseNone')}</p>
          {!isReadOnly && canEditCase && (
            <Button
              variant="secondary"
              size="sm"
              className="w-fit"
              disabled={disabled}
              onClick={() => setLinking(true)}
            >
              <i className="ti ti-link" aria-hidden="true" />
              {t('e2e.savedCaseLink')}
            </Button>
          )}
        </>
      )}
      {error && (
        <p className="text-xs text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
