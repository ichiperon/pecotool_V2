/**
 * Feature #203: OnboardingTour component tests
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { OnboardingTour, shouldShowOnboarding, resetOnboarding, ONBOARDING_STORAGE_KEY } from '../../components/OnboardingTour';

// framer-motion: replace with pass-through stubs to avoid animation issues in jsdom
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, onClick, style, className, role }: {
      children?: React.ReactNode;
      onClick?: React.MouseEventHandler;
      style?: React.CSSProperties;
      className?: string;
      role?: string;
    }) => (
      <div onClick={onClick} style={style} className={className} role={role}>
        {children}
      </div>
    ),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

beforeEach(() => {
  localStorage.clear();
});

describe('OnboardingTour: step rendering', () => {
  it('OT-01: renders step 1 title on initial mount', () => {
    render(<OnboardingTour onClose={vi.fn()} />);
    expect(screen.getByText('ようこそ PecoTool へ')).toBeTruthy();
  });

  it('OT-02: renders "次へ" button on first step', () => {
    render(<OnboardingTour onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: '次へ' })).toBeTruthy();
  });

  it('OT-03: renders "スキップ" button on first step', () => {
    render(<OnboardingTour onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'スキップ' })).toBeTruthy();
  });

  it('OT-04: "戻る" button is NOT visible on the first step', () => {
    render(<OnboardingTour onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '戻る' })).toBeNull();
  });

  it('OT-05: clicking "次へ" advances to step 2', () => {
    render(<OnboardingTour onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '次へ' }));
    expect(screen.getByText('PDF を読み込む')).toBeTruthy();
  });

  it('OT-06: step counter shows "1 / 5" on step 1', () => {
    render(<OnboardingTour onClose={vi.fn()} />);
    expect(screen.getByText('1 / 5')).toBeTruthy();
  });

  it('OT-07: step counter shows "2 / 5" after advancing to step 2', () => {
    render(<OnboardingTour onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '次へ' }));
    expect(screen.getByText('2 / 5')).toBeTruthy();
  });

  it('OT-08: "戻る" appears from step 2 onwards', () => {
    render(<OnboardingTour onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '次へ' }));
    expect(screen.getByRole('button', { name: '戻る' })).toBeTruthy();
  });

  it('OT-09: clicking "戻る" goes back to step 1', () => {
    render(<OnboardingTour onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '次へ' }));
    fireEvent.click(screen.getByRole('button', { name: '戻る' }));
    expect(screen.getByText('ようこそ PecoTool へ')).toBeTruthy();
  });
});

describe('OnboardingTour: last step', () => {
  function advanceToLastStep(onClose: () => void) {
    render(<OnboardingTour onClose={onClose} />);
    // Advance through all steps (5 total, need 4 clicks)
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByRole('button', { name: '次へ' }));
    }
  }

  it('OT-10: last step shows "ツアーを終了" instead of "次へ"', () => {
    advanceToLastStep(vi.fn());
    expect(screen.queryByRole('button', { name: '次へ' })).toBeNull();
    expect(screen.getByRole('button', { name: 'ツアーを終了' })).toBeTruthy();
  });

  it('OT-11: clicking "ツアーを終了" calls onClose', () => {
    const onClose = vi.fn();
    advanceToLastStep(onClose);
    fireEvent.click(screen.getByRole('button', { name: 'ツアーを終了' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('OT-12: clicking "ツアーを終了" sets localStorage flag', () => {
    advanceToLastStep(vi.fn());
    fireEvent.click(screen.getByRole('button', { name: 'ツアーを終了' }));
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe('true');
  });
});

describe('OnboardingTour: skip', () => {
  it('OT-13: clicking "スキップ" calls onClose', () => {
    const onClose = vi.fn();
    render(<OnboardingTour onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'スキップ' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('OT-14: clicking "スキップ" sets localStorage flag', () => {
    render(<OnboardingTour onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'スキップ' }));
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe('true');
  });
});

describe('shouldShowOnboarding / resetOnboarding', () => {
  it('OT-15: returns true when flag is not set', () => {
    expect(shouldShowOnboarding()).toBe(true);
  });

  it('OT-16: returns false when flag is "true"', () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, 'true');
    expect(shouldShowOnboarding()).toBe(false);
  });

  it('OT-17: resetOnboarding removes the flag', () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, 'true');
    resetOnboarding();
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull();
  });

  it('OT-18: shouldShowOnboarding returns true after resetOnboarding', () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, 'true');
    resetOnboarding();
    expect(shouldShowOnboarding()).toBe(true);
  });
});

describe('OnboardingTour: accessibility', () => {
  it('OT-19: root element has role="dialog" and aria-modal="true"', () => {
    render(<OnboardingTour onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'チュートリアル' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('OT-20: progress dots count matches total steps (5)', () => {
    const { container } = render(<OnboardingTour onClose={vi.fn()} />);
    const dots = container.querySelectorAll('.onboarding-dot');
    expect(dots).toHaveLength(5);
  });

  it('OT-21: first dot has "active" class on step 1', () => {
    const { container } = render(<OnboardingTour onClose={vi.fn()} />);
    const dots = container.querySelectorAll('.onboarding-dot');
    expect(dots[0].classList.contains('active')).toBe(true);
    expect(dots[1].classList.contains('active')).toBe(false);
  });

  it('OT-22: second dot becomes "active" on step 2', () => {
    const { container } = render(<OnboardingTour onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '次へ' }));
    const dots = container.querySelectorAll('.onboarding-dot');
    expect(dots[1].classList.contains('active')).toBe(true);
  });
});
