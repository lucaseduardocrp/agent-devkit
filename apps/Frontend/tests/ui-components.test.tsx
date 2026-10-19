import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button, buttonVariants } from '../src/components/ui/button.js';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '../src/components/ui/card.js';
import { Badge, badgeVariants } from '../src/components/ui/badge.js';
import { Input, inputVariants } from '../src/components/ui/input.js';
import { Select, selectVariants } from '../src/components/ui/select.js';
import { Textarea } from '../src/components/ui/textarea.js';
import {
  Skeleton,
  SkeletonText,
  SkeletonCard,
  SkeletonButton,
  SkeletonInput,
  SkeletonBadge,
  SkeletonListItem,
  SkeletonRow,
  SkeletonTestPlan,
} from '../src/components/ui/skeleton.js';
import { Toast } from '../src/components/ui/toast.js';
import { vi } from 'vitest';

describe('UI Primitives', () => {
  describe('Toast', () => {
    it('renders success and error feedback and can be dismissed', () => {
      const dismiss = vi.fn();
      const view = render(<Toast message="Salvo" onDismiss={dismiss} />);
      expect(view.getByRole('status')).toHaveTextContent('Salvo');
      fireEvent.click(view.getByRole('button', { name: 'Fechar notificação' }));
      expect(dismiss).toHaveBeenCalledOnce();
      view.rerender(<Toast message="Falhou" variant="error" onDismiss={dismiss} />);
      expect(view.getByRole('alert')).toHaveTextContent('Falhou');
    });
  });
  describe('Button', () => {
    it('renders with default variant and size (40px matching input height)', () => {
      const { getByRole } = render(<Button>Click me</Button>);
      const btn = getByRole('button', { name: 'Click me' });
      expect(btn).toBeInTheDocument();
      expect(btn.className).toContain('bg-[var(--fill-accent)]');
      expect(btn.className).toContain('h-[40px]');
    });

    it('renders with different variants and sizes', () => {
      const variants = ['destructive', 'outline', 'secondary', 'ghost', 'link'] as const;
      for (const variant of variants) {
        const { getByText } = render(
          <Button variant={variant} size="sm">
            {variant}
          </Button>,
        );
        expect(getByText(variant)).toBeInTheDocument();
      }

      const { getByText: getLg } = render(<Button size="lg">Large Button</Button>);
      expect(getLg('Large Button')).toBeInTheDocument();

      const { getByText: getIcon } = render(<Button size="icon">Icon</Button>);
      expect(getIcon('Icon')).toBeInTheDocument();
    });

    it('renders loading state with spinner and disabled', () => {
      const { getByRole, container } = render(<Button isLoading>Processando</Button>);
      const btn = getByRole('button', { name: 'Processando' }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(container.querySelector('.ti-loader.animate-spin')).toBeInTheDocument();
    });

    it('renders with leftIcon and rightIcon', () => {
      const { getByTestId } = render(
        <Button
          leftIcon={<span data-testid="left-icon">L</span>}
          rightIcon={<span data-testid="right-icon">R</span>}
        >
          Icon Button
        </Button>,
      );
      expect(getByTestId('left-icon')).toBeInTheDocument();
      expect(getByTestId('right-icon')).toBeInTheDocument();
    });

    it('exposes buttonVariants helper function', () => {
      expect(buttonVariants({ variant: 'outline' })).toContain('border');
    });
  });

  describe('Card', () => {
    it('renders complete card structure with header, title, desc, content and footer', () => {
      const { getByText } = render(
        <Card className="custom-card">
          <CardHeader className="custom-header">
            <CardTitle className="custom-title">Card Title</CardTitle>
            <CardDescription className="custom-desc">Card Description</CardDescription>
          </CardHeader>
          <CardContent className="custom-content">Content here</CardContent>
          <CardFooter className="custom-footer">Footer here</CardFooter>
        </Card>,
      );

      expect(getByText('Card Title')).toBeInTheDocument();
      expect(getByText('Card Description')).toBeInTheDocument();
      expect(getByText('Content here')).toBeInTheDocument();
      expect(getByText('Footer here')).toBeInTheDocument();
    });
  });

  describe('Badge', () => {
    it('renders badge with default variant', () => {
      const { getByText } = render(<Badge>Default Badge</Badge>);
      expect(getByText('Default Badge')).toBeInTheDocument();
    });

    it('renders badge with various variants', () => {
      const variants = ['success', 'warning', 'destructive', 'pro', 'outline'] as const;
      for (const variant of variants) {
        const { getByText } = render(<Badge variant={variant}>{variant}</Badge>);
        expect(getByText(variant)).toBeInTheDocument();
      }
    });

    it('exposes badgeVariants helper function', () => {
      expect(badgeVariants({ variant: 'success' })).toContain('bg-[var(--fill-success)]');
    });
  });

  describe('Input', () => {
    it('renders input with default 40px height and custom properties', () => {
      const { getByPlaceholderText } = render(
        <Input placeholder="Enter name" className="my-input" type="email" />,
      );
      const input = getByPlaceholderText('Enter name');
      expect(input).toBeInTheDocument();
      expect(input.getAttribute('type')).toBe('email');
      expect(input.className).toContain('h-[40px]');
      expect(input.className).toContain('my-input');
    });

    it('renders with variants and inputSize', () => {
      const { getByPlaceholderText: getErr } = render(
        <Input placeholder="Error input" variant="error" />,
      );
      expect(getErr('Error input').className).toContain('border-red-500');

      const { getByPlaceholderText: getFilled } = render(
        <Input placeholder="Filled input" variant="filled" />,
      );
      expect(getFilled('Filled input').className).toContain('bg-surface-1');

      const { getByPlaceholderText: getSm } = render(
        <Input placeholder="Small input" inputSize="sm" />,
      );
      expect(getSm('Small input').className).toContain('h-8');
    });

    it('renders leftIcon and rightIcon properly', () => {
      const { getByTestId, getByPlaceholderText } = render(
        <Input
          placeholder="With icons"
          leftIcon={<span data-testid="in-left">L</span>}
          rightIcon={<span data-testid="in-right">R</span>}
        />,
      );
      expect(getByTestId('in-left')).toBeInTheDocument();
      expect(getByTestId('in-right')).toBeInTheDocument();
      expect(getByPlaceholderText('With icons').className).toContain('pl-11');
      expect(getByPlaceholderText('With icons').className).toContain('pr-11');
    });

    it('exposes inputVariants helper function', () => {
      expect(inputVariants({ variant: 'error' })).toContain('border-red-500');
    });
  });

  describe('Select', () => {
    it('renders select with default 40px height and chevron icon', () => {
      const { getByRole, container } = render(
        <Select aria-label="Choose option">
          <option value="1">Option 1</option>
          <option value="2">Option 2</option>
        </Select>,
      );
      const select = getByRole('combobox', { name: 'Choose option' });
      expect(select).toBeInTheDocument();
      expect(select.className).toContain('h-[40px]');
      expect(container.querySelector('.ti-chevron-down')).toBeInTheDocument();
    });

    it('renders with variants and selectSize', () => {
      const { getByRole: getErr } = render(
        <Select variant="error" aria-label="Error select">
          <option>Option</option>
        </Select>,
      );
      expect(getErr('combobox', { name: 'Error select' }).className).toContain('border-red-500');

      const { getByRole: getFilled } = render(
        <Select variant="filled" aria-label="Filled select">
          <option>Option</option>
        </Select>,
      );
      expect(getFilled('combobox', { name: 'Filled select' }).className).toContain('bg-surface-1');

      const { getByRole: getSm } = render(
        <Select selectSize="sm" aria-label="Small select">
          <option>Option</option>
        </Select>,
      );
      expect(getSm('combobox', { name: 'Small select' }).className).toContain('h-8');
    });

    it('exposes selectVariants helper function', () => {
      expect(selectVariants({ variant: 'default' })).toContain('h-[40px]');
    });
  });

  describe('Textarea', () => {
    it('renders textarea with custom properties and className', () => {
      const { getByPlaceholderText } = render(
        <Textarea placeholder="Enter details" className="my-textarea" rows={4} />,
      );
      const textarea = getByPlaceholderText('Enter details');
      expect(textarea).toBeInTheDocument();
      expect(textarea.className).toContain('my-textarea');
    });
  });

  describe('Skeleton', () => {
    it('renders base skeleton with pulse animation and no border by default', () => {
      const { getByTestId } = render(<Skeleton className="h-6 w-20" />);
      const el = getByTestId('skeleton');
      expect(el).toBeInTheDocument();
      expect(el.className).toContain('animate-pulse');
      expect(el.className).toContain('rounded-full');
      expect(el.className).not.toContain('border');
      expect(el.className).toContain('h-6');
      expect(el.className).toContain('w-20');
    });

    it('renders skeleton without shimmer when disabled', () => {
      const { getByTestId } = render(<Skeleton shimmer={false} />);
      const el = getByTestId('skeleton');
      expect(el.className).not.toContain('animate-pulse');
    });

    it('renders SkeletonText with default and custom lines', () => {
      const { getByTestId: getDefault, unmount } = render(<SkeletonText />);
      const def = getDefault('skeleton-text');
      expect(def.children.length).toBe(3);
      unmount();

      const { getByTestId: getCustom } = render(<SkeletonText lines={5} className="my-text" />);
      const cust = getCustom('skeleton-text');
      expect(cust.children.length).toBe(5);
      expect(cust.className).toContain('my-text');
    });

    it('renders SkeletonCard with card structure', () => {
      const { getByTestId } = render(<SkeletonCard className="custom-card-skeleton" />);
      const card = getByTestId('skeleton-card');
      expect(card).toBeInTheDocument();
      expect(card.className).toContain('custom-card-skeleton');
    });

    it('renders SkeletonButton and SkeletonBadge', () => {
      const { getByTestId, unmount } = render(<SkeletonButton className="custom-btn" />);
      const btn = getByTestId('skeleton-button');
      expect(btn).toBeInTheDocument();
      expect(btn.className).toContain('custom-btn');
      unmount();

      const { getByTestId: getBadge } = render(<SkeletonBadge className="custom-badge" />);
      const badge = getBadge('skeleton-badge');
      expect(badge).toBeInTheDocument();
      expect(badge.className).toContain('custom-badge');
    });

    it('renders SkeletonInput, SkeletonListItem, SkeletonRow, and SkeletonTestPlan', () => {
      const { getByTestId, unmount } = render(<SkeletonInput className="custom-input" />);
      expect(getByTestId('skeleton-input')).toBeInTheDocument();
      unmount();

      const { getByTestId: getList, unmount: unmountList } = render(
        <SkeletonListItem className="custom-item" />,
      );
      expect(getList('skeleton-list-item')).toBeInTheDocument();
      unmountList();

      const { getByTestId: getRow, unmount: unmountRow } = render(
        <SkeletonRow className="custom-row" />,
      );
      expect(getRow('skeleton-row')).toBeInTheDocument();
      unmountRow();

      const { getByTestId: getPlan } = render(<SkeletonTestPlan className="custom-plan" />);
      expect(getPlan('skeleton-test-plan')).toBeInTheDocument();
    });
  });
});
