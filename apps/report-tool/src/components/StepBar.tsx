import type { FC } from "react";

const STEPS = [
  { label: "欄を定義", number: 1 },
  { label: "OCR 適用", number: 2 },
  { label: "確認", number: 3 },
  { label: "CSV 出力", number: 4 },
] as const;

interface StepBarProps {
  activeStep: 1 | 2 | 3 | 4;
}

const StepBar: FC<StepBarProps> = ({ activeStep }) => {
  return (
    <nav className="step-bar" aria-label="作業ステップ">
      <ol className="step-bar__list">
        {STEPS.map((step, index) => {
          const isActive = step.number === activeStep;
          const isCompleted = step.number < activeStep;
          const statusClass = isActive
            ? "step-bar__item--active"
            : isCompleted
              ? "step-bar__item--completed"
              : "step-bar__item--pending";

          return (
            <li key={step.number} className={`step-bar__item ${statusClass}`}>
              {index > 0 && <span className="step-bar__connector" aria-hidden="true" />}
              <span
                className="step-bar__number"
                aria-current={isActive ? "step" : undefined}
              >
                {isCompleted ? "✓" : step.number}
              </span>
              <span className="step-bar__label">{step.label}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
};

export default StepBar;
