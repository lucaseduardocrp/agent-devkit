import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GraphqlSchemaExplorer } from '../src/features/apitests/integration/GraphqlSchemaExplorer.js';
import type { GraphqlSchema } from '../src/features/apitests/integration/graphql-schema.js';

const scalar = (name: string) => ({ kind: 'SCALAR', name, ofType: null }) as const;

const schema: GraphqlSchema = {
  queryType: 'Query',
  mutationType: 'Mutation',
  subscriptionType: null,
  types: new Map([
    [
      'Query',
      {
        kind: 'OBJECT',
        name: 'Query',
        description: 'Entry points for reads.',
        fields: [{ name: 'user', description: 'A user by id.', args: [], type: scalar('User') }],
      },
    ],
    [
      'Mutation',
      { kind: 'OBJECT', name: 'Mutation', fields: [{ name: 'createUser', args: [], type: scalar('User') }] },
    ],
    ['User', { kind: 'OBJECT', name: 'User', fields: [{ name: 'name', args: [], type: scalar('String') }] }],
  ]),
};

describe('GraphqlSchemaExplorer', () => {
  it('opens a root type from the entry screen and goes back to it', () => {
    render(<GraphqlSchemaExplorer schema={schema} onClose={vi.fn()} onRefresh={vi.fn()} />);
    const root = screen.getByText('Query:').closest('ul')!;
    fireEvent.click(within(root).getByRole('button', { name: 'Mutation' }));
    expect(screen.getByText('createUser')).toBeInTheDocument();
  });

  it('asks to refresh and closes', () => {
    const onClose = vi.fn();
    const onRefresh = vi.fn();
    render(<GraphqlSchemaExplorer schema={schema} onClose={onClose} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recarregar schema' }));
    expect(onRefresh).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(onClose).toHaveBeenCalled();
  });
});
