import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { newRequest } from '../src/features/apitests/api-test-types.js';
import { RequestSettingsEditor } from '../src/features/apitests/integration/RequestSettingsEditor.js';

describe('RequestSettingsEditor', () => {
  it('shows the collection defaults as placeholders when the request has none', () => {
    const view = render(
      <RequestSettingsEditor
        request={newRequest('r', 'http', '{{baseUrl}}')}
        collection={{ settings: { timeoutMs: 5000, maxRedirects: 3 } }}
        readOnly={false}
        onChange={vi.fn()}
      />,
    );
    expect(view.getByLabelText('Timeout (ms)').getAttribute('placeholder')).toBe('5000');
    expect(view.getByLabelText('Máximo de redirecionamentos').getAttribute('placeholder')).toBe(
      '3',
    );
  });
});
