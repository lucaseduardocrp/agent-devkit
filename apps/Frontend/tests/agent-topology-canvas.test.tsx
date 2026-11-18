import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentTopology } from '../src/features/agents/AgentTopology.js';
import type { AgentWorkflowDto, CustomAgentDto } from '../src/features/agents/agent-types.js';
import type { AgentRun, Issue } from '../src/features/issues/issue-types.js';

const workflow: AgentWorkflowDto = {
  enabled: true,
  autonomy: 'balanced',
  finalReview: true,
  uncertaintyBehavior: 'ask',
  issueCreationBehavior: 'ask',
  defaultAction: 'allow',
  steps: [],
  rules: [],
};

const parent: CustomAgentDto = {
  id: 'parent',
  workspaceId: 'workspace',
  parentAgentId: null,
  name: 'QA Lead',
  slug: 'qa-lead',
  description: 'Coordinates QA',
  instructions: 'Review tests',
  role: 'QA',
  temperature: 0.2,
  isSystem: false,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};
const child: CustomAgentDto = {
  ...parent,
  id: 'child',
  parentAgentId: 'parent',
  name: 'BDD Agent',
  slug: 'bdd-agent',
};
const issue: Issue = {
  id: 'issue-1',
  workspaceId: 'workspace',
  number: 42,
  title: 'Write scenarios',
  description: '',
  status: 'in_progress',
  priority: 'medium',
  assigneeAgentId: 'child',
  assigneeUserId: null,
  createdBy: 'user',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};
const run: AgentRun = {
  id: 'run-1',
  issueId: issue.id,
  agentId: child.id,
  status: 'running',
  mode: 'host',
  attempt: 1,
  output: null,
  error: null,
  provider: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  costMicros: null,
  createdAt: '2026-01-01',
  startedAt: '2026-01-01',
  finishedAt: null,
};

function renderMap() {
  return render(
    <AgentTopology
      agents={[parent, child]}
      issues={[issue]}
      runs={[run]}
      isLoading={false}
      error={null}
      onRefresh={vi.fn()}
      workflow={workflow}
    />,
  );
}

/** jsdom has no PointerEvent: a mouse event of the pointer type carries the coordinates. */
function pointer(type: string, target: Element, x = 0, y = 0) {
  fireEvent(
    target,
    new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }),
  );
}

const zoom = () => Number(screen.getByTestId('topology-zoom-level').textContent.replace('%', ''));
const surface = () => screen.getByTestId('topology-scroll-area');
const layer = () => screen.getByTestId('topology-layer');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AgentTopology canvas', () => {
  it('zooms with the toolbar and with ctrl + wheel, and fits the map again', () => {
    renderMap();
    expect(zoom()).toBe(100);

    fireEvent.click(screen.getByTestId('topology-zoom-in'));
    expect(zoom()).toBe(115);
    fireEvent.click(screen.getByTestId('topology-zoom-out'));
    expect(zoom()).toBe(100);

    fireEvent.wheel(surface(), { deltaY: -100, ctrlKey: true });
    expect(zoom()).toBe(115);
    fireEvent.wheel(surface(), { deltaY: 100, ctrlKey: true });
    // A plain wheel is left to the page.
    fireEvent.wheel(surface(), { deltaY: -100 });
    expect(zoom()).toBe(100);

    fireEvent.click(screen.getByTestId('topology-zoom-in'));
    fireEvent.click(screen.getByTestId('topology-reset-view'));
    expect(zoom()).toBe(100);
  });

  it('pans by dragging the background but not when pressing a node', () => {
    renderMap();
    const origin = layer().style.transform;

    // Moving without a pressed pointer does nothing.
    pointer('pointermove', surface(), 50, 50);
    expect(layer().style.transform).toBe(origin);

    // A press on a node is a click on it, not a drag of the canvas.
    pointer('pointerdown', screen.getByTestId('topology-agent-parent'), 10, 10);
    pointer('pointermove', surface(), 60, 40);
    expect(layer().style.transform).toBe(origin);

    pointer('pointerdown', surface(), 10, 10);
    expect(surface().className).toContain('cursor-grabbing');
    pointer('pointermove', surface(), 60, 40);
    expect(layer().style.transform).toContain('translate(50px, 30px)');
    pointer('pointermove', surface(), 70, 40);
    expect(layer().style.transform).toContain('translate(60px, 30px)');
    pointer('pointerup', surface());
    expect(surface().className).toContain('cursor-grab');
    expect(surface().className).not.toContain('cursor-grabbing');

    pointer('pointerdown', surface(), 0, 0);
    pointer('pointerout', surface());
    pointer('pointermove', surface(), 500, 500);
    expect(layer().style.transform).toContain('translate(60px, 30px)');
  });

  it('frames every agent and task in the height it is given, and keeps them framed on resize', () => {
    let resized!: () => void;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    let height = 200;
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(2000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height);

    const view = renderMap();
    // Two agents and one task need 240px, and 2000px is wide enough: a 200px canvas frames them smaller than 100%.
    const fitted = zoom();
    expect(fitted).toBeLessThan(100);

    // A taller canvas frames them larger, up to 100%.
    height = 2000;
    act(() => resized());
    expect(zoom()).toBe(100);

    // The person's own zoom wins over a resize.
    fireEvent.click(screen.getByTestId('topology-zoom-out'));
    height = 200;
    act(() => resized());
    expect(zoom()).toBe(85);

    view.unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it('selects an agent or a task from the canvas', () => {
    renderMap();
    fireEvent.click(screen.getByTestId('topology-run-run-1'));
    expect(screen.getByTestId('agent-run-flow')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    fireEvent.click(screen.getByTestId('topology-agent-parent'));
    expect(screen.getByTestId('agent-run-flow')).toBeInTheDocument();
  });
});
