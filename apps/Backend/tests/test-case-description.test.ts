import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { DeterministicTestPlanGenerator } from '../src/modules/testplans/application/generate-test-plan.js';
import {
  escapeHtml,
  flowFromSteps,
  normalizeTestCaseDescription,
  renderFlow,
  renderTestCaseDescription,
} from '../src/modules/testplans/domain/test-case-description.js';
import { parseAndNormalizeTestPlans } from '../src/modules/testplans/domain/test-plan.js';

const NBSP = ' ';

const certification = {
  useCase:
    'Validar a exibição da nova coluna "Subtipo de Evento" no relatório de Status de Certificação.',
  preconditions: 'Usuário autenticado com perfil de acesso ao relatório de Status de Certificação.',
  inputData: 'Navegação para a tela de relatório.',
  expectedResult: 'A coluna "Subtipo de Evento" é exibida seguindo o padrão visual das demais.',
  postconditions: 'Relatório exibido corretamente na tela com a nova coluna integrada.',
  flow: [
    { step: 'Acessar Painel' },
    { step: 'Abrir Relatório' },
    { decision: 'Possui Subtipo?', yes: 'Exibir Subtipo', no: 'Exibir "-"' },
  ],
};

describe('test case description template', () => {
  it('renders bold ## headings in order and the process flow diagram', () => {
    const html = renderTestCaseDescription(certification);
    const headings = [...html.matchAll(/<b>## ([^<]+)<\/b>/g)].map((match) => match[1]);
    expect(headings).toEqual([
      'Caso de uso',
      'Pré-condições',
      'Dados de entrada',
      'Resultado esperado',
      'Pós-condições',
      'Fluxo do Processo',
    ]);
    expect(html).toContain(
      '<b>## Caso de uso</b><br>Validar a exibição da nova coluna "Subtipo de Evento"',
    );
    expect(html.split('<br><br>')).toHaveLength(6);

    const flow = html.split('<b>## Fluxo do Processo</b><br>')[1]!.split('<br>');
    expect(flow).toEqual([
      '┌──────────────────┐',
      `│${NBSP}[Acessar Painel]${NBSP}│`,
      '└──────────────────┘',
      '│',
      '▼',
      '┌───────────────────┐',
      `│${NBSP}[Abrir Relatório]${NBSP}│`,
      '└───────────────────┘',
      '│',
      '▼',
      '┌───────────────────┐',
      `│${NBSP}(Possui Subtipo?)${NBSP}│`,
      '└───────────────────┘',
      '│',
      `├─(SIM)─▶️${NBSP}[Exibir Subtipo]`,
      '│',
      `└─(NÃO)─▶️${NBSP}[Exibir "-"]`,
    ]);
  });

  it('escapes model text, keeps line breaks and marks empty sections', () => {
    const html = renderTestCaseDescription({
      ...certification,
      useCase: 'Linha 1\nLinha <script>2</script> & fim',
      postconditions: '   ',
      flow: [],
    });
    expect(html).toContain('Linha 1<br>Linha &lt;script&gt;2&lt;/script&gt; &amp; fim');
    expect(html).toContain('<b>## Pós-condições</b><br>Não informado.');
    expect(html).not.toContain('Fluxo do Processo');
    expect(escapeHtml('<a & b>')).toBe('&lt;a &amp; b&gt;');
  });

  it('uses English headings and branches for English cases', () => {
    const html = renderTestCaseDescription({ ...certification, useCase: '' }, 'en-US');
    expect(html).toContain('<b>## Use case</b><br>Not provided.');
    expect(html).toContain('<b>## Process flow</b>');
    expect(html).toContain('├─(YES)─▶️');
    expect(html).toContain('└─(NO)─▶️');
  });

  it('shortens long labels, keeps existing brackets and caps the number of nodes', () => {
    const long = 'x'.repeat(80);
    const [top, middle] = renderFlow([{ step: long }]);
    expect(middle).toBe(`│${NBSP}[${'x'.repeat(59)}…]${NBSP}│`);
    expect(top).toHaveLength(middle!.length);
    expect(renderFlow([{ step: '[Já entre colchetes]' }])[1]).toContain('[Já entre colchetes]');
    const many = Array.from({ length: 20 }, (_, index) => ({ step: `Passo ${index}` }));
    expect(renderFlow(many).filter((line) => line.startsWith('│' + NBSP))).toHaveLength(12);
  });

  it('normalizes structured, legacy and free-text descriptions', () => {
    const structured = normalizeTestCaseDescription(
      {
        useCase: 'Objetivo',
        flow: ['Abrir tela', { label: 'Salvar' }, { decision: 'Válido?' }, 42, {}, null],
      },
      'pt-BR',
      [],
    );
    expect(structured).toContain('<b>## Caso de uso</b><br>Objetivo');
    expect(structured).toContain('[Abrir tela]');
    expect(structured).toContain('[Salvar]');
    expect(structured).toContain('├─(SIM)─▶️ [-]');

    const legacy = normalizeTestCaseDescription(
      '## Caso de uso\nValidar login\n<b>## Pré-condições:</b>\nUsuário <i>ativo</i>\\n## Dados de entrada\nE-mail',
      'pt-BR',
      ['Abrir o login.', 'Informar e-mail;'],
    );
    expect(legacy).toContain('<b>## Caso de uso</b><br>Validar login');
    expect(legacy).toContain('<b>## Pré-condições</b><br>Usuário ativo');
    expect(legacy).toContain('<b>## Dados de entrada</b><br>E-mail');
    expect(legacy).toContain('<b>## Resultado esperado</b><br>Não informado.');
    expect(legacy).toContain('[Abrir o login]');
    expect(legacy).toContain('[Informar e-mail]');

    const partial = normalizeTestCaseDescription('## Pós-condições\nSessão encerrada', 'pt-BR', []);
    expect(partial).toContain('<b>## Caso de uso</b><br>Não informado.');
    expect(partial).toContain('<b>## Pós-condições</b><br>Sessão encerrada');

    const english = normalizeTestCaseDescription('## Use case\nSign in', 'en-US', []);
    expect(english).toContain('<b>## Use case</b><br>Sign in');

    const free = normalizeTestCaseDescription('<p>Requisito livre</p>', 'pt-BR', ['Executar']);
    expect(free).toContain('<b>## Caso de uso</b><br>Requisito livre');
    expect(normalizeTestCaseDescription(undefined, 'pt-BR', [])).toContain('Não informado.');
    expect(normalizeTestCaseDescription(['array'], 'pt-BR', [])).toContain('Não informado.');
    expect(flowFromSteps([' Abrir. ', '', 'Salvar'])).toEqual([
      { step: 'Abrir' },
      { step: 'Salvar' },
    ]);
  });
});

describe('description template in every generation path', () => {
  it('renders descriptions of model output in the requested language', () => {
    const plans = parseAndNormalizeTestPlans(
      JSON.stringify([
        {
          title: 'Coluna Subtipo',
          description: certification,
          steps: [{ action: 'Acessar o Painel', expected: 'Painel exibido' }],
        },
      ]),
      { language: 'pt-BR' },
    );
    expect(plans[0]!.description).toContain('<b>## Fluxo do Processo</b>');
    expect(plans[0]!.metadata?.formattedDescription).toBe(plans[0]!.description);
  });

  it('uses the template in the deterministic fallback', async () => {
    const result = await new DeterministicTestPlanGenerator().generate({
      prompt: 'O usuário deve acessar o relatório de certificação',
    });
    expect(result.description).toContain(
      '<b>## Caso de uso</b><br>O usuário deve acessar o relatório de certificação',
    );
    expect(result.description).toContain('<b>## Fluxo do Processo</b>');
  });

  it('applies the template to plans saved by MCP hosts', async () => {
    const app = createApp({
      requestContextResolver: () => ({ requestId: 't', ownerId: 'ws-1', workspaceId: 'ws-1' }),
    });
    const saved = await request(app)
      .post('/TestPlan')
      .send({
        plans: [
          {
            title: 'Coluna Subtipo',
            description: certification,
            steps: [{ action: 'Acessar o menu Painel', expectedResult: 'Painel exibido' }],
          },
        ],
      });
    expect(saved.status).toBe(201);
    expect(saved.body.plans[0].description).toContain('(Possui Subtipo?)');
    expect(saved.body.csv).toContain('## Caso de uso');

    const english = await request(app)
      .post('/TestPlan')
      .send({
        plans: [
          {
            title: 'Open the report',
            description: 'Check the report',
            steps: [{ action: 'Open the report screen', expectedResult: 'The report is shown' }],
          },
        ],
      });
    expect(english.body.plans[0].description).toContain('<b>## Use case</b><br>Check the report');
  });
});
