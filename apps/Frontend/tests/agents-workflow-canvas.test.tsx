import React, { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentWorkflowBoard } from '../src/features/agents/AgentWorkflowBoard.js';
import { I18nProvider } from '../src/lib/i18n/index.js';
import { WORKFLOW_TRIGGER_NODE_ID } from '../src/features/agents/workflow-graph.js';
import type {
  AgentWorkflowDto,
  AgentWorkflowToolset,
  CustomAgentDto,
} from '../src/features/agents/agent-types.js';

const agent: CustomAgentDto = {
  id: 'agent-1',
  workspaceId: 'workspace',
  parentAgentId: null,
  name: 'QA Lead',
  slug: 'qa-lead',
  description: '',
  instructions: '',
  role: 'QA',
  temperature: 0.2,
  isSystem: false,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

const toolNames = Object.fromEntries(
  (
    [
      'all',
      'agents',
      'integrations',
      'brain',
      'issues',
      'pbi',
      'spec',
      'testplans',
      'design',
      'e2e',
      'releasenotes',
      'development',
      'integrationtests',
      'loadtests',
      'audit',
      'workspaces',
      'notifications',
    ] as AgentWorkflowToolset[]
  ).map((toolset) => [toolset, [`${toolset}_create`]]),
) as unknown as Record<AgentWorkflowToolset, readonly string[]>;

const baseWorkflow: AgentWorkflowDto = {
  enabled: true,
  autonomy: 'balanced',
  finalReview: true,
  uncertaintyBehavior: 'ask',
  issueCreationBehavior: 'ask',
  defaultAction: 'allow',
  steps: [
    { id: 'step-a', name: 'Plan', instructions: 'plan it', agentId: 'agent-1' },
    { id: 'step-b', name: 'Review', instructions: 'review it' },
  ],
  rules: [],
};

/** The board is controlled, so the tests drive it through a small stateful host. */
function Host({
  initial = baseWorkflow,
  isReadOnly = false,
  isDirty = false,
  onWorkflow,
  notificationOptions,
}: {
  readonly notificationOptions?: React.ComponentProps<
    typeof AgentWorkflowBoard
  >['notificationOptions'];
  readonly initial?: AgentWorkflowDto;
  readonly isReadOnly?: boolean;
  readonly isDirty?: boolean;
  readonly onWorkflow?: (workflow: AgentWorkflowDto) => void;
}): React.JSX.Element {
  const [workflow, setWorkflow] = useState(initial);
  return (
    <I18nProvider initialLocale="en-US">
      <AgentWorkflowBoard
        workflow={workflow}
        agents={[agent]}
        isReadOnly={isReadOnly}
        isDirty={isDirty}
        toolNames={toolNames}
        providerOptions={[{ id: 'github', name: 'GitHub' }]}
        {...(notificationOptions ? { notificationOptions } : {})}
        onChange={(next) => {
          setWorkflow(next);
          onWorkflow?.(next);
        }}
        onSave={() => {}}
      />
    </I18nProvider>
  );
}

/**
 * jsdom has no PointerEvent, and the library's fallback drops the coordinates the canvas reads,
 * so the pointer gestures are dispatched as mouse events carrying the pointer event name.
 */
function pointer(
  type: string,
  target: Element,
  init: { readonly clientX?: number; readonly clientY?: number } = {},
) {
  fireEvent(
    target,
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: init.clientX ?? 0,
      clientY: init.clientY ?? 0,
    }),
  );
}

const pointerDown = (target: Element, init?: { clientX: number; clientY: number }) =>
  pointer('pointerdown', target, init);
const pointerMove = (target: Element, init?: { clientX: number; clientY: number }) =>
  pointer('pointermove', target, init);
const pointerUp = (target: Element, init?: { clientX: number; clientY: number }) =>
  pointer('pointerup', target, init);
const pointerLeave = (target: Element) => pointer('pointerout', target);

const canvas = () => screen.getByTestId('workflow-canvas');
const node = (id: string) => screen.getByTestId(`workflow-node-${id}`);

/** A pointer press, travel and release, as the canvas listens for them. */
function dragPointer(
  target: Element,
  from: { x: number; y: number },
  to: { x: number; y: number },
  release: Element = canvas(),
) {
  pointerDown(target, { clientX: from.x, clientY: from.y });
  pointerMove(canvas(), { clientX: to.x, clientY: to.y });
  pointerUp(release, { clientX: to.x, clientY: to.y });
}

describe('AgentWorkflowBoard canvas', () => {
  it('lays an unarranged workflow out as a start node and its steps', () => {
    render(<Host />);
    expect(node(WORKFLOW_TRIGGER_NODE_ID)).toBeInTheDocument();
    expect(node('step-a')).toHaveTextContent('Plan');
    expect(node('step-a')).toHaveTextContent('QA Lead');
    expect(node('step-b')).toHaveTextContent('Use the agent requested for the task');
  });

  it('opens a node in the inspector when it is clicked rather than dragged', () => {
    render(<Host />);
    pointerDown(node('step-a'), { clientX: 352, clientY: 160 });
    pointerUp(node('step-a'), { clientX: 352, clientY: 160 });
    expect(screen.getByTestId('workflow-inspector')).toHaveTextContent('Plan');
  });

  it('opens the trigger and the workflow settings from the trigger node', () => {
    render(<Host />);
    pointerDown(node(WORKFLOW_TRIGGER_NODE_ID), { clientX: 48, clientY: 160 });
    pointerUp(node(WORKFLOW_TRIGGER_NODE_ID), { clientX: 48, clientY: 160 });
    expect(screen.getByTestId('workflow-inspector')).toHaveTextContent('What starts the workflow');
  });

  it('moves a node to where it was dropped, snapped to the grid', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    dragPointer(node('step-a'), { x: 352, y: 160 }, { x: 403, y: 300 });

    const saved = onWorkflow.mock.lastCall![0] as AgentWorkflowDto;
    expect(saved.canvas!.nodes.find((entry) => entry.id === 'step-a')).toMatchObject({
      x: 400,
      y: 304,
    });
    expect(screen.queryByTestId('workflow-inspector')).toBeNull();
  });

  it('ignores pointer travel too small to be a drag', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    pointerDown(node('step-a'), { clientX: 352, clientY: 160 });
    pointerMove(canvas(), { clientX: 353, clientY: 161 });
    pointerUp(node('step-a'), { clientX: 353, clientY: 161 });
    expect(onWorkflow).not.toHaveBeenCalled();
    expect(screen.getByTestId('workflow-inspector')).toBeInTheDocument();
  });

  it('wires one node to a second target, so a node can feed several others', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    dragPointer(
      screen.getByTestId(`workflow-port-${WORKFLOW_TRIGGER_NODE_ID}`),
      { x: 264, y: 208 },
      { x: 700, y: 208 },
      node('step-b'),
    );

    const saved = onWorkflow.mock.lastCall![0] as AgentWorkflowDto;
    expect(
      saved.canvas!.edges.filter((edge) => edge.from === WORKFLOW_TRIGGER_NODE_ID),
    ).toHaveLength(2);
  });

  it('shows the connection being drawn and drops it when it lands on nothing', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    pointerDown(screen.getByTestId(`workflow-port-${WORKFLOW_TRIGGER_NODE_ID}`), {
      clientX: 264,
      clientY: 208,
    });
    pointerMove(canvas(), { clientX: 500, clientY: 400 });
    expect(screen.getByTestId('workflow-link-preview')).toBeInTheDocument();
    pointerUp(canvas(), { clientX: 500, clientY: 400 });
    expect(onWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a connection the runner could not execute', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    dragPointer(
      screen.getByTestId('workflow-port-step-b'),
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      node('step-a'),
    );
    expect(onWorkflow).not.toHaveBeenCalled();
  });

  it('removes a connection from the canvas', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    fireEvent.click(screen.getByTestId('workflow-edge-remove-edge-step-a-step-b'));

    const saved = onWorkflow.mock.lastCall![0] as AgentWorkflowDto;
    expect(saved.canvas!.edges.map((edge) => edge.id)).toEqual(['edge-start-step-a']);
  });

  it('pans the canvas without touching the workflow', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    pointerDown(canvas(), { clientX: 10, clientY: 10 });
    pointerMove(canvas(), { clientX: 80, clientY: 40 });
    pointerUp(canvas(), { clientX: 80, clientY: 40 });
    expect(onWorkflow).not.toHaveBeenCalled();
  });

  it('abandons a gesture when the pointer leaves the canvas', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    pointerDown(node('step-a'), { clientX: 352, clientY: 160 });
    pointerLeave(canvas());
    pointerUp(canvas(), { clientX: 352, clientY: 160 });
    pointerMove(canvas(), { clientX: 500, clientY: 500 });
    expect(onWorkflow).not.toHaveBeenCalled();
  });

  it('zooms with the toolbar and with ctrl + wheel, and resets the view', () => {
    render(<Host />);
    fireEvent.click(screen.getByTestId('workflow-zoom-in'));
    expect(screen.getByTestId('workflow-zoom-level')).toHaveTextContent('115%');
    fireEvent.click(screen.getByTestId('workflow-zoom-out'));
    expect(screen.getByTestId('workflow-zoom-level')).toHaveTextContent('100%');

    fireEvent.wheel(canvas(), { deltaY: -100, ctrlKey: true });
    expect(screen.getByTestId('workflow-zoom-level')).toHaveTextContent('115%');
    fireEvent.wheel(canvas(), { deltaY: 100, ctrlKey: true });
    fireEvent.wheel(canvas(), { deltaY: -100 });
    expect(screen.getByTestId('workflow-zoom-level')).toHaveTextContent('100%');

    fireEvent.click(screen.getByTestId('workflow-zoom-in'));
    fireEvent.click(screen.getByTestId('workflow-reset-view'));
    expect(screen.getByTestId('workflow-zoom-level')).toHaveTextContent('100%');
  });
});

describe('AgentWorkflowBoard initial view', () => {
  /** jsdom has no layout: give the canvas a size, as the browser would. */
  function mockSurface(width: number, height: number) {
    const spies = [
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width),
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(height),
    ];
    return { mockRestore: () => spies.forEach((spy) => spy.mockRestore()) };
  }
  const zoom = () => Number(screen.getByTestId('workflow-zoom-level').textContent.replace('%', ''));

  it('opens with the whole flow in view and refits it with the reset button', () => {
    // The default flow (trigger + 2 steps) is wider than a 640 px canvas.
    const spy = mockSurface(640, 560);
    try {
      render(<Host />);
      const fitted = zoom();
      expect(fitted).toBeLessThan(100);
      expect(fitted).toBeGreaterThanOrEqual(20);

      // The user's own zoom is kept while editing, and reset frames the flow again.
      fireEvent.click(screen.getByTestId('workflow-zoom-in'));
      expect(zoom()).toBeGreaterThan(fitted);
      fireEvent.click(screen.getByTestId('workflow-reset-view'));
      expect(zoom()).toBe(fitted);
    } finally {
      spy.mockRestore();
    }
  });

  it('frames the flow once the canvas gets its size, for a canvas laid out after it mounts', () => {
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
    let width = 0;
    const spies = [
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width),
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(560),
    ];
    try {
      const view = render(<Host />);
      expect(zoom()).toBe(100);
      // Still no size: it keeps waiting.
      act(() => resized());
      expect(zoom()).toBe(100);
      expect(disconnect).not.toHaveBeenCalled();

      width = 640;
      act(() => resized());
      expect(zoom()).toBeLessThan(100);
      // The canvas keeps watching its size: a larger one gets the flow framed larger.
      expect(disconnect).not.toHaveBeenCalled();
      width = 2000;
      act(() => resized());
      expect(zoom()).toBe(100);
      view.unmount();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      spies.forEach((spy) => spy.mockRestore());
      vi.unstubAllGlobals();
    }
  });

  it('keeps the flow in view when the canvas is resized, until the person zooms it themselves', () => {
    let resized!: () => void;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    let width = 640;
    const spies = [
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width),
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(560),
    ];
    try {
      render(<Host />);
      const fitted = zoom();

      // A narrower canvas (a tablet turned upright) frames the flow smaller.
      width = 480;
      act(() => resized());
      expect(zoom()).toBeLessThan(fitted);

      // The person's own zoom wins over a resize ...
      fireEvent.click(screen.getByTestId('workflow-zoom-in'));
      const zoomed = zoom();
      width = 2000;
      act(() => resized());
      expect(zoom()).toBe(zoomed);

      // ... until the view is reset, which hands the framing back to the canvas.
      fireEvent.click(screen.getByTestId('workflow-reset-view'));
      expect(zoom()).toBe(100);
      width = 480;
      act(() => resized());
      expect(zoom()).toBeLessThan(100);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
      vi.unstubAllGlobals();
    }
  });

  it('frames the flow again when a node is added, as long as the view was left alone', () => {
    const spy = mockSurface(640, 560);
    try {
      render(<Host />);
      const fitted = zoom();
      fireEvent.click(screen.getByTestId('workflow-add-approval'));
      // The new node made the flow wider, and it still fits.
      expect(zoom()).toBeLessThan(fitted);
    } finally {
      spy.mockRestore();
    }
  });

  it('leaves the view alone once the canvas was panned', () => {
    const spy = mockSurface(640, 560);
    try {
      render(<Host />);
      const surface = () => canvas().firstElementChild as HTMLElement;
      dragPointer(canvas(), { x: 100, y: 100 }, { x: 160, y: 130 });
      const panned = surface().style.transform;
      fireEvent.click(screen.getByTestId('workflow-add-approval'));
      expect(surface().style.transform).toBe(panned);
    } finally {
      spy.mockRestore();
    }
  });

  it('stops waiting for a size when the canvas goes away first', () => {
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect = disconnect;
      },
    );
    try {
      render(<Host />).unmount();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not reframe the flow after the first view, even when the flow changes', () => {
    const spy = mockSurface(640, 560);
    try {
      render(<Host />);
      fireEvent.click(screen.getByTestId('workflow-zoom-in'));
      const zoomed = zoom();
      fireEvent.click(screen.getByTestId('workflow-add-approval'));
      expect(zoom()).toBe(zoomed);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('AgentWorkflowBoard approval nodes', () => {
  it('adds an approval node at the open end of the flow and gates the step before it', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    fireEvent.click(screen.getByTestId('workflow-add-approval'));

    const saved = onWorkflow.mock.lastCall![0] as AgentWorkflowDto;
    const approval = saved.canvas!.nodes.find((entry) => entry.kind === 'approval')!;
    expect(saved.canvas!.edges.some((edge) => edge.to === approval.id)).toBe(true);
    expect(saved.steps.find((entry) => entry.id === 'step-b')!.reviewRequired).toBe(true);
    expect(screen.getByText('1 approval gates', { exact: false })).toBeInTheDocument();
    expect(screen.getByTestId(`workflow-node-${approval.id}`)).toHaveTextContent(
      'Requires approval',
    );
  });

  it('keeps the approval gate out of the step inspector', () => {
    render(<Host />);
    fireEvent.click(screen.getByTestId('workflow-add-approval'));
    pointerDown(node('step-b'), { clientX: 0, clientY: 0 });
    pointerUp(node('step-b'), { clientX: 0, clientY: 0 });
    expect(screen.getByTestId('workflow-inspector')).toBeInTheDocument();
    expect(screen.queryByText('Approval required after this step')).not.toBeInTheDocument();
    expect(screen.queryByText('No approval after this step')).not.toBeInTheDocument();
  });

  it('removes an approval node and the gate it carried', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    fireEvent.click(screen.getByTestId('workflow-add-approval'));
    const approval = (onWorkflow.mock.lastCall![0] as AgentWorkflowDto).canvas!.nodes.find(
      (entry) => entry.kind === 'approval',
    )!;

    pointerDown(screen.getByTestId(`workflow-node-remove-${approval.id}`));
    fireEvent.click(screen.getByTestId(`workflow-node-remove-${approval.id}`));

    const saved = onWorkflow.mock.lastCall![0] as AgentWorkflowDto;
    expect(saved.canvas!.nodes.some((entry) => entry.kind === 'approval')).toBe(false);
    expect(saved.steps.find((entry) => entry.id === 'step-b')!.reviewRequired).toBe(false);
  });

  it('closes the inspector when the open node is removed from the canvas', () => {
    render(<Host />);
    fireEvent.click(screen.getByTestId('workflow-add-approval'));
    pointerDown(node('step-b'), { clientX: 0, clientY: 0 });
    pointerUp(node('step-b'), { clientX: 0, clientY: 0 });
    expect(screen.getByTestId('workflow-inspector')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('workflow-node-remove-step-b'));
    expect(screen.queryByTestId('workflow-inspector')).toBeNull();
  });
});

describe('AgentWorkflowBoard open flow node', () => {
  it('forgets the open flow node when it is removed', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    fireEvent.click(screen.getByTestId('workflow-add-delay'));
    const approval = onWorkflow.mock.calls
      .at(-1)![0]
      .canvas.nodes.find((entry: { kind: string }) => entry.kind === 'delay');
    pointerDown(node(approval.id), { clientX: 0, clientY: 0 });
    pointerUp(node(approval.id), { clientX: 0, clientY: 0 });
    fireEvent.click(screen.getByTestId('workflow-node-remove-' + approval.id));
    expect(screen.queryByTestId('workflow-node-' + approval.id)).toBeNull();
  });

  it('keeps another node open when a different flow node is removed', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    fireEvent.click(screen.getByTestId('workflow-add-delay'));
    const delay = onWorkflow.mock.calls
      .at(-1)![0]
      .canvas.nodes.find((entry: { kind: string }) => entry.kind === 'delay');
    pointerDown(node('step-a'), { clientX: 0, clientY: 0 });
    pointerUp(node('step-a'), { clientX: 0, clientY: 0 });
    fireEvent.click(screen.getByTestId('workflow-node-remove-' + delay.id));
    expect(screen.queryByTestId('workflow-node-' + delay.id)).toBeNull();
    expect(screen.getByTestId('workflow-inspector')).toBeInTheDocument();
  });
});

describe('AgentWorkflowBoard steps and rules', () => {
  it('adds a step wired to the open end of the flow and opens it', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    fireEvent.click(screen.getByTestId('workflow-add-step'));

    const saved = onWorkflow.mock.lastCall![0] as AgentWorkflowDto;
    expect(saved.steps).toHaveLength(3);
    expect(saved.steps.at(-1)!.id).toBe(saved.canvas!.edges.at(-1)!.to);
    expect(screen.getByTestId('workflow-inspector')).toHaveTextContent('Untitled step');
  });

  it('leaves a new node unconnected when the flow has several open ends', () => {
    const onWorkflow = vi.fn();
    render(
      <Host
        initial={{
          ...baseWorkflow,
          canvas: {
            nodes: [
              { id: WORKFLOW_TRIGGER_NODE_ID, kind: 'start', x: 0, y: 0 },
              { id: 'step-a', kind: 'step', x: 300, y: 0 },
              { id: 'step-b', kind: 'step', x: 300, y: 200 },
            ],
            edges: [
              { id: 'e1', from: WORKFLOW_TRIGGER_NODE_ID, to: 'step-a' },
              { id: 'e2', from: WORKFLOW_TRIGGER_NODE_ID, to: 'step-b' },
            ],
          },
        }}
        onWorkflow={onWorkflow}
      />,
    );
    fireEvent.click(screen.getByTestId('workflow-add-approval'));

    const saved = onWorkflow.mock.lastCall![0] as AgentWorkflowDto;
    expect(saved.canvas!.edges).toHaveLength(2);
  });

  it('removes a step from the canvas and from the workflow', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    fireEvent.click(screen.getByTestId('workflow-node-remove-step-a'));

    const saved = onWorkflow.mock.lastCall![0] as AgentWorkflowDto;
    expect(saved.steps.map((entry) => entry.id)).toEqual(['step-b']);
    expect(saved.canvas!.nodes.some((entry) => entry.id === 'step-a')).toBe(false);
  });

  it('edits a step through the inspector', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    pointerDown(node('step-a'), { clientX: 0, clientY: 0 });
    pointerUp(node('step-a'), { clientX: 0, clientY: 0 });
    fireEvent.change(screen.getByDisplayValue('Plan'), { target: { value: 'Planning' } });
    expect((onWorkflow.mock.lastCall![0] as AgentWorkflowDto).steps[0]!.name).toBe('Planning');
  });

  it('keeps the rules out of the canvas and opens them in the same inspector', () => {
    render(<Host />);
    fireEvent.click(screen.getByTestId('workflow-add-rule'));
    expect(screen.getByTestId('workflow-inspector')).toHaveTextContent('Rule 1');
  });

  it('offers no editing affordance while the workflow is read-only', () => {
    render(<Host isReadOnly />);
    expect(screen.getByTestId('workflow-add-step')).toHaveAttribute('disabled');
    expect(screen.getByTestId('workflow-add-approval')).toHaveAttribute('disabled');
    expect(screen.getByTestId('workflow-port-step-a')).toHaveAttribute('disabled');
    expect(screen.queryByTestId('workflow-node-remove-step-a')).toBeNull();
    expect(screen.queryByTestId('workflow-edge-remove-edge-start-step-a')).toBeNull();

    pointerDown(node('step-a'), { clientX: 0, clientY: 0 });
    pointerUp(node('step-a'), { clientX: 0, clientY: 0 });
    expect(screen.queryByTestId('workflow-inspector')).toBeNull();
  });

  it('locks the settings that are open when the permission to edit is lost', () => {
    const view = render(<Host />);
    pointerDown(node(WORKFLOW_TRIGGER_NODE_ID));
    pointerUp(node(WORKFLOW_TRIGGER_NODE_ID));
    const finalReview = () =>
      screen.getByRole<HTMLInputElement>('switch', {
        name: 'Require approval of the final result',
      });
    expect(finalReview().disabled).toBe(false);

    view.rerender(<Host isReadOnly />);
    expect(finalReview().disabled).toBe(true);
  });

  it('dims the canvas while the workflow is turned off', () => {
    render(<Host initial={{ ...baseWorkflow, enabled: false }} />);
    expect(canvas()).toHaveClass('opacity-[0.78]');
  });
});

describe('AgentWorkflowBoard inspector', () => {
  const openSettings = () => {
    pointerDown(node(WORKFLOW_TRIGGER_NODE_ID));
    pointerUp(node(WORKFLOW_TRIGGER_NODE_ID));
  };

  it('edits every workflow setting from the start node', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    openSettings();

    fireEvent.change(screen.getByLabelText('Agent autonomy'), { target: { value: 'supervised' } });
    expect((onWorkflow.mock.lastCall![0] as AgentWorkflowDto).autonomy).toBe('supervised');

    fireEvent.change(screen.getByLabelText('When information is missing'), {
      target: { value: 'assume' },
    });
    expect((onWorkflow.mock.lastCall![0] as AgentWorkflowDto).uncertaintyBehavior).toBe('assume');

    fireEvent.change(screen.getByLabelText('Issue creation by MCP agents'), {
      target: { value: 'allow' },
    });
    expect((onWorkflow.mock.lastCall![0] as AgentWorkflowDto).issueCreationBehavior).toBe('allow');

    fireEvent.change(screen.getByLabelText('Unconfigured actions'), { target: { value: 'deny' } });
    expect((onWorkflow.mock.lastCall![0] as AgentWorkflowDto).defaultAction).toBe('deny');

    fireEvent.click(screen.getByRole('switch', { name: 'Require approval of the final result' }));
    expect((onWorkflow.mock.lastCall![0] as AgentWorkflowDto).finalReview).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('workflow-inspector')).toBeNull();
  });

  it('turns the workflow off from the header switch', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    fireEvent.click(screen.getByTestId('workflow-enabled-toggle'));
    expect((onWorkflow.mock.lastCall![0] as AgentWorkflowDto).enabled).toBe(false);
  });

  it('assigns an agent to a step and closes the inspector', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    pointerDown(node('step-b'));
    pointerUp(node('step-b'));

    fireEvent.change(screen.getByLabelText('Responsible agent'), { target: { value: 'agent-1' } });
    expect((onWorkflow.mock.lastCall![0] as AgentWorkflowDto).steps[1]!.agentId).toBe('agent-1');

    fireEvent.change(screen.getByLabelText('Step instructions'), { target: { value: 'again' } });
    expect((onWorkflow.mock.lastCall![0] as AgentWorkflowDto).steps[1]!.instructions).toBe('again');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('workflow-inspector')).toBeNull();
  });

  it('clears the agent of a step', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    pointerDown(node('step-a'));
    pointerUp(node('step-a'));
    fireEvent.change(screen.getByLabelText('Responsible agent'), { target: { value: '' } });
    expect((onWorkflow.mock.lastCall![0] as AgentWorkflowDto).steps[0]!.agentId).toBeUndefined();
  });

  it('removes a step from the inspector', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    pointerDown(node('step-a'));
    pointerUp(node('step-a'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove step 1' }));
    expect((onWorkflow.mock.lastCall![0] as AgentWorkflowDto).steps.map((s) => s.id)).toEqual([
      'step-b',
    ]);
  });

  it('edits a module rule', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    fireEvent.click(screen.getByTestId('workflow-add-rule'));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'No deletes' } });
    expect((onWorkflow.mock.lastCall![0] as AgentWorkflowDto).rules[0]!.name).toBe('No deletes');

    fireEvent.change(screen.getByLabelText('Module'), { target: { value: 'issues' } });
    expect((onWorkflow.mock.lastCall![0] as AgentWorkflowDto).rules[0]!.toolset).toBe('issues');

    fireEvent.change(screen.getByLabelText(/MCP action/), { target: { value: ' delete_issue ' } });
    expect((onWorkflow.mock.lastCall![0] as AgentWorkflowDto).rules[0]!.toolName).toBe(
      'delete_issue',
    );

    fireEvent.change(screen.getByLabelText(/Allowed providers/), {
      target: { value: 'github, github, azure' },
    });
    expect((onWorkflow.mock.lastCall![0] as AgentWorkflowDto).rules[0]!.allowedProviders).toEqual([
      'github',
      'azure',
    ]);

    fireEvent.change(screen.getByLabelText(/Allowed providers/), { target: { value: '  ' } });
    expect(
      (onWorkflow.mock.lastCall![0] as AgentWorkflowDto).rules[0]!.allowedProviders,
    ).toBeUndefined();

    fireEvent.change(screen.getByLabelText(/MCP action/), { target: { value: '' } });
    expect((onWorkflow.mock.lastCall![0] as AgentWorkflowDto).rules[0]!.toolName).toBeUndefined();
  });

  it('toggles the switches of a module rule', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    fireEvent.click(screen.getByTestId('workflow-add-rule'));

    fireEvent.click(screen.getByRole('switch', { name: 'Ask before each action' }));
    expect((onWorkflow.mock.lastCall![0] as AgentWorkflowDto).rules[0]!.requireApproval).toBe(true);

    fireEvent.click(screen.getByRole('switch', { name: 'Open an Issue for each change' }));
    expect((onWorkflow.mock.lastCall![0] as AgentWorkflowDto).rules[0]!.createIssueForAction).toBe(
      true,
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Block action' }));
    expect((onWorkflow.mock.lastCall![0] as AgentWorkflowDto).rules[0]!.effect).toBe('deny');
    const ruleId = (onWorkflow.mock.lastCall![0] as AgentWorkflowDto).rules[0]!.id;
    expect(screen.getByTestId(`workflow-node-${ruleId}`)).toHaveTextContent('Blocked');

    fireEvent.click(screen.getByRole('switch', { name: 'Block action' }));
    expect((onWorkflow.mock.lastCall![0] as AgentWorkflowDto).rules[0]!.effect).toBe('allow');
  });

  it('removes a module rule', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    fireEvent.click(screen.getByTestId('workflow-add-rule'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove rule Rule 1' }));
    expect((onWorkflow.mock.lastCall![0] as AgentWorkflowDto).rules).toEqual([]);
  });

  it('reopens a rule node from the canvas', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    fireEvent.click(screen.getByTestId('workflow-add-rule'));
    const ruleId = (onWorkflow.mock.lastCall![0] as AgentWorkflowDto).rules[0]!.id;
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    pointerDown(node(ruleId), { clientX: 0, clientY: 0 });
    pointerUp(node(ruleId), { clientX: 0, clientY: 0 });
    expect(screen.getByTestId('workflow-inspector')).toHaveTextContent('Rule 1');
  });
});

describe('AgentWorkflowBoard header', () => {
  it('shows the unsaved marker and saves', () => {
    const onSave = vi.fn();
    render(
      <I18nProvider initialLocale="en-US">
        <AgentWorkflowBoard
          workflow={baseWorkflow}
          agents={[agent]}
          isDirty
          toolNames={toolNames}
          providerOptions={[{ id: 'github', name: 'GitHub' }]}
          onChange={() => {}}
          onSave={onSave}
        />
      </I18nProvider>,
    );
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('workflow-save-button'));
    expect(onSave).toHaveBeenCalled();
  });

  it('reports that it is saving', () => {
    render(
      <I18nProvider initialLocale="en-US">
        <AgentWorkflowBoard
          workflow={baseWorkflow}
          agents={[agent]}
          isDirty
          isSaving
          toolNames={toolNames}
          providerOptions={[]}
          onChange={() => {}}
          onSave={() => {}}
        />
      </I18nProvider>,
    );
    expect(screen.getByTestId('workflow-save-button')).toHaveAttribute('disabled');
  });
});

describe('AgentWorkflowBoard edge cases', () => {
  it('pads the step number of a long flow to two digits', () => {
    const steps = Array.from({ length: 10 }, (_, index) => ({
      id: `step-${index}`,
      name: `Step ${index}`,
      instructions: 'go',
    }));
    render(<Host initial={{ ...baseWorkflow, steps }} />);
    expect(node('step-9')).toHaveTextContent('Step 10');
    expect(node('step-0')).toHaveTextContent('Step 01');
  });

  it('names an unnamed rule and leaves the other rules alone while one is edited', () => {
    const onWorkflow = vi.fn();
    render(
      <Host
        initial={{
          ...baseWorkflow,
          rules: [
            { id: 'rule-1', name: '', toolset: 'pbi', effect: 'allow' },
            { id: 'rule-2', name: 'Second', toolset: 'issues', effect: 'allow' },
          ],
        }}
        onWorkflow={onWorkflow}
      />,
    );
    expect(screen.getByTestId('workflow-node-rule-1')).toHaveTextContent('Rule');

    pointerDown(node('rule-1'), { clientX: 0, clientY: 0 });
    pointerUp(node('rule-1'), { clientX: 0, clientY: 0 });
    expect(screen.getByTestId('workflow-inspector')).toHaveTextContent('Rule');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('workflow-inspector')).toBeNull();

    pointerDown(node('rule-2'), { clientX: 0, clientY: 0 });
    pointerUp(node('rule-2'), { clientX: 0, clientY: 0 });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });

    const saved = onWorkflow.mock.lastCall![0] as AgentWorkflowDto;
    expect(saved.rules.map((rule) => rule.name)).toEqual(['', 'Renamed']);
  });

  it('closes the inspector when the node it shows is removed from the canvas', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    fireEvent.click(screen.getByTestId('workflow-add-approval'));
    const approval = (onWorkflow.mock.lastCall![0] as AgentWorkflowDto).canvas!.nodes.find(
      (entry) => entry.kind === 'approval',
    )!;

    pointerDown(screen.getByTestId(`workflow-node-${approval.id}`));
    pointerUp(screen.getByTestId(`workflow-node-${approval.id}`));
    fireEvent.click(screen.getByTestId(`workflow-node-remove-${approval.id}`));
    expect(screen.queryByTestId(`workflow-node-${approval.id}`)).toBeNull();
  });
});

describe('AgentWorkflowBoard trigger node', () => {
  const openTrigger = () => {
    pointerDown(node(WORKFLOW_TRIGGER_NODE_ID));
    pointerUp(node(WORKFLOW_TRIGGER_NODE_ID));
  };

  it('starts on the issue trigger and switches to a product event', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    expect(node(WORKFLOW_TRIGGER_NODE_ID)).toHaveTextContent('An Issue is assigned to an agent');

    openTrigger();
    fireEvent.change(screen.getByLabelText('What starts the workflow'), {
      target: { value: 'product-event' },
    });
    fireEvent.click(screen.getByRole('switch', { name: 'PBI created' }));

    const saved = onWorkflow.mock.lastCall![0] as AgentWorkflowDto;
    const trigger = saved.canvas!.nodes.find((entry) => entry.kind === 'trigger')!.trigger;
    expect(trigger).toEqual({ kind: 'product-event', events: ['pbi.created'] });
    expect(node(WORKFLOW_TRIGGER_NODE_ID)).toHaveTextContent('PBI created');
  });

  it('removes an event it already listens to', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    openTrigger();
    fireEvent.change(screen.getByLabelText('What starts the workflow'), {
      target: { value: 'product-event' },
    });
    fireEvent.click(screen.getByRole('switch', { name: 'Spec published' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Spec published' }));

    const saved = onWorkflow.mock.lastCall![0] as AgentWorkflowDto;
    expect(saved.canvas!.nodes[0]!.trigger).toEqual({ kind: 'product-event', events: [] });
  });

  it('asks for a cron expression on a scheduled trigger and refuses to save without one', () => {
    const onWorkflow = vi.fn();
    render(<Host isDirty onWorkflow={onWorkflow} />);
    openTrigger();
    fireEvent.change(screen.getByLabelText('What starts the workflow'), {
      target: { value: 'schedule' },
    });
    expect(screen.getByTestId('workflow-save-button')).toHaveAttribute('disabled');
    expect(screen.getByTestId('workflow-incomplete-warning')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '0 9 * * 1' } });
    const saved = onWorkflow.mock.lastCall![0] as AgentWorkflowDto;
    expect(saved.canvas!.nodes[0]!.trigger).toEqual({ kind: 'schedule', cron: '0 9 * * 1' });
    expect(node(WORKFLOW_TRIGGER_NODE_ID)).toHaveTextContent('0 9 * * 1');
    expect(screen.queryByTestId('workflow-incomplete-warning')).toBeNull();
  });

  it('clears a cron expression that was emptied', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    openTrigger();
    fireEvent.change(screen.getByLabelText('What starts the workflow'), {
      target: { value: 'schedule' },
    });
    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '  ' } });
    const saved = onWorkflow.mock.lastCall![0] as AgentWorkflowDto;
    expect(saved.canvas!.nodes[0]!.trigger).toEqual({ kind: 'schedule' });
  });
});

describe('AgentWorkflowBoard action, condition and delay nodes', () => {
  /** Adds a node of the given kind and returns the id it was given on the canvas. */
  const addKind = (kind: string, onWorkflow: ReturnType<typeof vi.fn>) => {
    fireEvent.click(screen.getByTestId(`workflow-add-${kind}`));
    const saved = onWorkflow.mock.lastCall![0] as AgentWorkflowDto;
    return saved.canvas!.nodes.find((entry) => entry.kind === kind)!.id;
  };

  it('adds an action node, wires it to the flow and configures it', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    const id = addKind('action', onWorkflow);

    expect(screen.getByTestId('workflow-action-inspector')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-action-server-limit')).toBeInTheDocument();
    expect(node(id)).toHaveTextContent('Needs configuration');

    fireEvent.change(screen.getByLabelText('Module'), { target: { value: 'issues' } });
    fireEvent.change(screen.getByLabelText(/MCP action/), { target: { value: 'create_issue' } });
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'github' } });

    const saved = onWorkflow.mock.lastCall![0] as AgentWorkflowDto;
    expect(saved.canvas!.nodes.find((entry) => entry.id === id)!.action).toEqual({
      toolset: 'issues',
      toolName: 'create_issue',
      provider: 'github',
    });
    expect(saved.canvas!.edges.some((edge) => edge.to === id)).toBe(true);
    expect(node(id)).toHaveTextContent('create_issue');
  });

  it('configures a notification: the module picks the only action and shows its editor', () => {
    const onWorkflow = vi.fn();
    render(
      <Host
        onWorkflow={onWorkflow}
        notificationOptions={{
          channels: [{ id: 'email', label: 'E-mail', available: true }],
          members: [],
          failed: false,
        }}
      />,
    );
    const id = addKind('action', onWorkflow);
    expect(screen.queryByTestId('notification-action-editor')).toBeNull();
    fireEvent.change(screen.getByLabelText('Module'), { target: { value: 'notifications' } });

    expect(screen.getByTestId('notification-action-editor')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('channel-email'));
    fireEvent.click(screen.getByTestId('node-role-assignee'));
    fireEvent.change(screen.getByTestId('node-subject'), { target: { value: 'Hello' } });

    const saved = onWorkflow.mock.lastCall![0] as AgentWorkflowDto;
    expect(saved.canvas!.nodes.find((entry) => entry.id === id)!.action).toEqual({
      toolset: 'notifications',
      toolName: 'notifications_send',
      notification: {
        channels: ['email'],
        userIds: [],
        roles: ['assignee'],
        subject: 'Hello',
        message: '',
      },
    });

    // Another module drops the action, and with it the notification settings.
    fireEvent.change(screen.getByLabelText('Module'), { target: { value: 'brain' } });
    expect(screen.queryByTestId('notification-action-editor')).toBeNull();
  });

  it('shows the notification editor without options when the board was given none', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    addKind('action', onWorkflow);
    fireEvent.change(screen.getByLabelText('Module'), { target: { value: 'notifications' } });
    expect(screen.getByTestId('notification-action-editor')).toBeInTheDocument();
  });

  it('forgets the action name when the module changes, and clears the provider', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    const id = addKind('action', onWorkflow);
    fireEvent.change(screen.getByLabelText(/MCP action/), { target: { value: 'create_issue' } });
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'github' } });
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Module'), { target: { value: 'brain' } });

    const saved = onWorkflow.mock.lastCall![0] as AgentWorkflowDto;
    expect(saved.canvas!.nodes.find((entry) => entry.id === id)!.action).toEqual({
      toolset: 'brain',
    });
  });

  it('clears the action name and closes the inspector', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    const id = addKind('action', onWorkflow);
    fireEvent.change(screen.getByLabelText(/MCP action/), { target: { value: 'create_issue' } });
    fireEvent.change(screen.getByLabelText(/MCP action/), { target: { value: '   ' } });

    const saved = onWorkflow.mock.lastCall![0] as AgentWorkflowDto;
    expect(saved.canvas!.nodes.find((entry) => entry.id === id)!.action).toEqual({
      toolset: 'pbi',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('workflow-inspector')).toBeNull();
  });

  it('adds a condition node with a true and a false output', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    const id = addKind('condition', onWorkflow);

    expect(screen.getByTestId('workflow-condition-inspector')).toBeInTheDocument();
    expect(screen.getByTestId(`workflow-port-${id}-true`)).toBeInTheDocument();
    expect(screen.getByTestId(`workflow-port-${id}-false`)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Comparison'), { target: { value: 'matches' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'APPROVED' } });

    const saved = onWorkflow.mock.lastCall![0] as AgentWorkflowDto;
    expect(saved.canvas!.nodes.find((entry) => entry.id === id)!.condition).toEqual({
      operator: 'matches',
      value: 'APPROVED',
    });
    expect(node(id)).toHaveTextContent('APPROVED');
  });

  it('remembers which output a connection left a condition by', () => {
    const onWorkflow = vi.fn();
    render(
      <Host
        initial={{
          ...baseWorkflow,
          canvas: {
            nodes: [
              { id: WORKFLOW_TRIGGER_NODE_ID, kind: 'trigger', x: 0, y: 0 },
              {
                id: 'cond',
                kind: 'condition',
                x: 300,
                y: 0,
                condition: { operator: 'contains', value: 'ok' },
              },
              { id: 'step-a', kind: 'step', x: 600, y: 0 },
              { id: 'step-b', kind: 'step', x: 600, y: 200 },
            ],
            edges: [{ id: 'e1', from: WORKFLOW_TRIGGER_NODE_ID, to: 'cond' }],
          },
        }}
        onWorkflow={onWorkflow}
      />,
    );

    dragPointer(
      screen.getByTestId('workflow-port-cond-true'),
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      node('step-a'),
    );
    dragPointer(
      screen.getByTestId('workflow-port-cond-false'),
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      node('step-b'),
    );

    const saved = onWorkflow.mock.lastCall![0] as AgentWorkflowDto;
    const branches = saved
      .canvas!.edges.filter((edge) => edge.from === 'cond')
      .map((edge) => `${edge.fromPort}:${edge.to}`);
    expect(branches).toEqual(['true:step-a', 'false:step-b']);
  });

  it('adds a delay node and bounds how long it waits', () => {
    const onWorkflow = vi.fn();
    render(<Host isDirty onWorkflow={onWorkflow} />);
    const id = addKind('delay', onWorkflow);
    expect(screen.getByTestId('workflow-delay-inspector')).toBeInTheDocument();
    expect(node(id)).toHaveTextContent('Wait 5 min');

    fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '999' } });
    expect(screen.getByTestId('workflow-save-button')).toHaveAttribute('disabled');

    fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '15' } });
    const saved = onWorkflow.mock.lastCall![0] as AgentWorkflowDto;
    expect(saved.canvas!.nodes.find((entry) => entry.id === id)!.delay).toEqual({ minutes: 15 });
    expect(screen.getByTestId('workflow-save-button')).not.toHaveAttribute('disabled');
  });

  it('removes a configuration node from its own inspector', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} />);
    const id = addKind('delay', onWorkflow);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Wait from the canvas' }));

    const saved = onWorkflow.mock.lastCall![0] as AgentWorkflowDto;
    expect(saved.canvas!.nodes.some((entry) => entry.id === id)).toBe(false);
    expect(screen.queryByTestId('workflow-inspector')).toBeNull();
  });

  it('keeps the canvas read-only without edit permission', () => {
    render(
      <Host
        isReadOnly
        initial={{
          ...baseWorkflow,
          canvas: {
            nodes: [
              { id: WORKFLOW_TRIGGER_NODE_ID, kind: 'trigger', x: 0, y: 0 },
              { id: 'step-a', kind: 'step', x: 300, y: 0 },
              { id: 'step-b', kind: 'step', x: 600, y: 0 },
              { id: 'cond', kind: 'condition', x: 900, y: 0 },
            ],
            edges: [],
          },
        }}
      />,
    );
    expect(screen.getByTestId('workflow-add-action')).toHaveAttribute('disabled');
    expect(screen.getByTestId('workflow-port-cond-true')).toHaveAttribute('disabled');
  });
});

describe('AgentWorkflowBoard notification nodes', () => {
  const options = {
    channels: [{ id: 'email', label: 'E-mail', available: true }],
    members: [],
    failed: false,
  };

  it('adds a notification node that is already a notifications_send action', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} notificationOptions={options} />);
    fireEvent.click(screen.getByTestId('workflow-add-notification'));

    const saved = onWorkflow.mock.lastCall![0] as AgentWorkflowDto;
    const added = saved.canvas!.nodes.find(
      (entry) => (entry.action as { toolset?: string } | undefined)?.toolset === 'notifications',
    )!;
    expect(added.kind).toBe('action');
    expect(added.action).toEqual({ toolset: 'notifications', toolName: 'notifications_send' });
    expect(saved.canvas!.edges.some((edge) => edge.to === added.id)).toBe(true);

    // It opens on the notification editor, without the warning about actions a server cannot run.
    expect(screen.getByTestId('notification-action-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('workflow-action-server-limit')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Notification' })).toBeInTheDocument();
    expect(node(added.id)).toHaveTextContent('Needs configuration');
  });

  it('shows the subject and channels on the node once it is configured', () => {
    const onWorkflow = vi.fn();
    render(<Host onWorkflow={onWorkflow} notificationOptions={options} />);
    fireEvent.click(screen.getByTestId('workflow-add-notification'));
    const id = (onWorkflow.mock.lastCall![0] as AgentWorkflowDto).canvas!.nodes.find(
      (entry) => (entry.action as { toolset?: string } | undefined)?.toolset === 'notifications',
    )!.id;

    fireEvent.click(screen.getByTestId('channel-email'));
    fireEvent.click(screen.getByTestId('node-role-assignee'));
    expect(node(id)).toHaveTextContent('Notification');
    expect(node(id)).toHaveTextContent('email');
    expect(node(id)).not.toHaveTextContent('Needs configuration');

    fireEvent.change(screen.getByTestId('node-subject'), { target: { value: 'Done' } });
    expect(node(id)).toHaveTextContent('Done');
  });

  it('cannot be added to a read-only workflow', () => {
    render(<Host isReadOnly />);
    expect(screen.getByTestId('workflow-add-notification')).toHaveAttribute('disabled');
  });

  it('says no channel is chosen when a stored node has settings but no channel', () => {
    render(
      <Host
        initial={{
          ...baseWorkflow,
          canvas: {
            nodes: [
              { id: WORKFLOW_TRIGGER_NODE_ID, kind: 'trigger', x: 0, y: 0 },
              {
                id: 'tell',
                kind: 'action',
                x: 300,
                y: 0,
                action: {
                  toolset: 'notifications',
                  toolName: 'notifications_send',
                  notification: { channels: [], userIds: [], roles: [], subject: '', message: '' },
                },
              },
            ],
            edges: [],
          },
        }}
      />,
    );
    expect(node('tell')).toHaveTextContent('Notification');
  });
});
