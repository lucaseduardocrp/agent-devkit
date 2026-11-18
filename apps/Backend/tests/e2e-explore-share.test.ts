import { describe, expect, it } from 'vitest';
import {
  ExploreWorkPool,
  type ExploreTest,
} from '../src/modules/e2e/application/e2e-explore-share.js';

const test = (id: string, title: string, description = '', steps: string[] = []): ExploreTest => ({
  id,
  title,
  description,
  steps,
});

/** Everything a pool hands out, browser by browser, until nothing is left. */
function drain(pool: ExploreWorkPool, workers: number) {
  const taken = Array.from({ length: workers }, () => ({
    areas: [] as string[],
    tests: [] as string[],
  }));
  pool.releaseAll();
  for (let worker = 0; pool.remaining > 0; worker = (worker + 1) % workers) {
    const batch = pool.claim(worker);
    if (!batch) continue;
    taken[worker]!.areas.push(...batch.areas);
    taken[worker]!.tests.push(...batch.tests);
  }
  return taken;
}

describe('the work shared by parallel browsers', () => {
  const shares = [['Colaboradores', 'Treinamentos'], ['Planejamento'], ['Fornecedores']];

  it('gives a test to the browser whose area it names, ignoring case and accents', () => {
    const pool = new ExploreWorkPool(shares, [
      test('T1', 'Filtrar colaboradores por nome'),
      test('T2', 'Criar PLANEJAMENTO semanal'),
      test('T3', 'Cadastrar fornecedores'),
      test('T4', 'Concluir treinamentos obrigatórios'),
    ]);
    expect(pool.claim(0)!.tests).toEqual(['T1', 'T4']);
    expect(pool.claim(1)!.tests).toEqual(['T2']);
    expect(pool.claim(2)!.tests).toEqual(['T3']);
  });

  it('knows a word in the singular and in the plural, or with another ending', () => {
    const pool = new ExploreWorkPool(
      [['Colaborador'], ['Equipes de campo']],
      [
        test('T1', 'Listar colaboradores ativos'),
        test('T2', 'Abrir a equipe do turno'),
        test('T3', 'Ver relatórios'),
      ],
    );
    expect(pool.claim(0)!.tests).toEqual(['T1']);
    expect(pool.claim(1)!.tests).toEqual(['T2']);
  });

  it('matches the words of the description and the steps, and prefers the whole name of an area', () => {
    const pool = new ExploreWorkPool(
      [['Equipes de campo'], ['Planejamento semanal']],
      [test('T1', 'Baixar arquivos', 'Na tela de equipes', ['Abrir o menu Planejamento semanal'])],
    );
    // Both areas share a word with the test; only the second is named as a whole.
    expect(pool.claim(0)!.tests).toEqual([]);
    expect(pool.claim(1)!.tests).toEqual(['T1']);
  });

  it('leaves tests that name no area to whoever is free first', () => {
    const pool = new ExploreWorkPool(shares, [
      test('T1', 'Exportar relatório'),
      test('T2', 'Ver painel'),
      test('T3', 'Mudar idioma'),
    ]);
    // Not given by subject, and not given beforehand: the first to ask takes them.
    expect(pool.claim(2)!.tests).toEqual(['T1', 'T2']);
    expect(pool.claim(0)!.tests).toEqual(['T3']);
  });

  it('breaks a tie between two areas by the browser with fewer tests', () => {
    const pool = new ExploreWorkPool(
      [['Colaboradores'], ['Planejamento']],
      [test('T1', 'Colaboradores e planejamento'), test('T2', 'Colaboradores e planejamento')],
    );
    pool.releaseAll();
    expect(pool.claim(0)!.tests).toHaveLength(1);
    expect(pool.claim(1)!.tests).toHaveLength(1);
  });

  it('hands out small pieces, areas and tests together', () => {
    const pool = new ExploreWorkPool(
      [['A', 'B', 'C', 'D']],
      ['1', '2', '3', '4', '5'].map((id) => test(id, `Teste ${id} sobre A`)),
    );
    expect(pool.claim(0)).toEqual({ areas: ['A', 'B'], tests: ['1', '2'] });
    expect(pool.claim(0)).toEqual({ areas: ['C', 'D'], tests: ['3', '4'] });
    expect(pool.claim(0)).toEqual({ areas: [], tests: ['5'] });
    expect(pool.claim(0)).toBeNull();
    expect(pool.remaining).toBe(0);
  });

  it('lets a browser that ran out take the back half of the queue of one that is working', () => {
    const pool = new ExploreWorkPool([['A', 'B', 'C', 'D', 'E', 'F'], ['G']], []);
    // The first browser is working; the second has done its own and takes from the back.
    pool.claim(0);
    expect(pool.claim(1)).toEqual({ areas: ['G'], tests: [] });
    expect(pool.claim(1)).toEqual({ areas: ['E', 'F'], tests: [] });
    // The first still has the front of its queue, in order.
    expect(pool.claim(0)).toEqual({ areas: ['C', 'D'], tests: [] });
    expect(pool.claim(0)).toBeNull();
  });

  it('does not take from a browser that has not started: it is about to', () => {
    const pool = new ExploreWorkPool([['A'], ['B', 'C']], []);
    expect(pool.claim(0)).toEqual({ areas: ['A'], tests: [] });
    // The second one is still opening its browser.
    expect(pool.claim(0)).toBeNull();
    expect(pool.remaining).toBe(2);
    // If it cannot start, its work is released.
    pool.release(1);
    expect(pool.claim(0)).toEqual({ areas: ['C'], tests: [] });
  });

  it('gives every test and every area once, whoever asks and in whatever order', () => {
    const tests = Array.from({ length: 9 }, (_, index) =>
      test(`T${index}`, index % 2 ? 'Cadastrar fornecedores' : 'Ver o painel'),
    );
    const taken = drain(new ExploreWorkPool(shares, tests), 3);
    expect(taken.flatMap((item) => item.tests).sort()).toEqual(tests.map((item) => item.id).sort());
    expect(taken.flatMap((item) => item.areas).sort()).toEqual(shares.flat().sort());
  });
});
