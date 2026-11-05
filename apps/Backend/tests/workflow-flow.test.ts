import { describe, expect, it } from 'vitest';
import type { AgentWorkflowCanvas } from '../src/modules/agents/domain/agent-workflow.js';
import {
  canvasNeedsFlowRunner,
  delayMinutes,
  flowNext,
  flowNode,
  flowStart,
  matchesCondition,
} from '../src/modules/agents/domain/workflow-flow.js';

const canvas: AgentWorkflowCanvas = {
  nodes: [
    { id: 'start', kind: 'trigger', x: 0, y: 0 },
    { id: 'gate', kind: 'condition', x: 1, y: 0, condition: { operator: 'contains', value: 'ok' } },
    { id: 'yes', kind: 'step', x: 2, y: 0 },
    { id: 'no', kind: 'step', x: 2, y: 1 },
  ],
  edges: [
    { id: 'e1', from: 'start', to: 'gate' },
    { id: 'e2', from: 'gate', fromPort: 'true', to: 'yes' },
    { id: 'e3', from: 'gate', fromPort: 'false', to: 'no' },
  ],
};

describe('workflow flow', () => {
  it('walks only canvases holding a node the step list cannot express', () => {
    expect(canvasNeedsFlowRunner(canvas)).toBe(true);
    expect(canvasNeedsFlowRunner(undefined)).toBe(false);
    expect(
      canvasNeedsFlowRunner({
        nodes: [
          { id: 'start', kind: 'trigger', x: 0, y: 0 },
          { id: 'one', kind: 'step', x: 1, y: 0 },
          { id: 'gate', kind: 'approval', x: 2, y: 0 },
        ],
        edges: [],
      }),
    ).toBe(false);
  });

  it('starts after the trigger and leaves a condition by the named port', () => {
    expect(flowStart(canvas)).toBe('gate');
    expect(flowNext(canvas, 'gate', 'true')).toBe('yes');
    expect(flowNext(canvas, 'gate', 'false')).toBe('no');
    // The unnamed output of a condition is not an edge any node leaves by.
    expect(flowNext(canvas, 'gate')).toBeUndefined();
    expect(flowNext(canvas, 'yes')).toBeUndefined();
    expect(flowNode(canvas, 'gate')?.kind).toBe('condition');
    expect(flowNode(canvas, 'missing')).toBeUndefined();
  });

  it('starts at the node after a trigger that does not use the reserved id', () => {
    expect(
      flowStart({
        nodes: [
          { id: 'other', kind: 'trigger', x: 0, y: 0 },
          { id: 'one', kind: 'step', x: 1, y: 0 },
        ],
        edges: [{ id: 'e1', from: 'other', to: 'one' }],
      }),
    ).toBe('one');
    expect(flowStart({ nodes: [], edges: [] })).toBeUndefined();
  });

  it('compares the previous result without caring about case', () => {
    expect(matchesCondition({ operator: 'contains', value: 'Aprovado' }, 'tudo aprovado')).toBe(
      true,
    );
    expect(matchesCondition({ operator: 'contains', value: 'bloqueio' }, 'tudo aprovado')).toBe(
      false,
    );
    expect(matchesCondition({ operator: 'not-contains', value: 'erro' }, 'tudo aprovado')).toBe(
      true,
    );
    expect(
      matchesCondition({ operator: 'matches', value: '^tudo\\s+\\w+$' }, 'tudo aprovado'),
    ).toBe(true);
    expect(() => matchesCondition({ operator: 'matches', value: '(' }, 'x')).toThrow();
  });

  it('clamps a delay to what the runner may wait out in process', () => {
    expect(delayMinutes({ id: 'd', kind: 'delay', x: 0, y: 0, delay: { minutes: 5 } })).toBe(5);
    expect(delayMinutes({ id: 'd', kind: 'delay', x: 0, y: 0, delay: { minutes: 900 } })).toBe(60);
    expect(delayMinutes({ id: 'd', kind: 'delay', x: 0, y: 0, delay: { minutes: -3 } })).toBe(0);
    expect(delayMinutes({ id: 'd', kind: 'delay', x: 0, y: 0 })).toBe(0);
  });
});
