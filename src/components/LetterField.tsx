"use client";

/** §7.11 信笺行：无边框透明底 + 一条底线，聚焦转青——不像表单，像在信纸上写字 */
export default function LetterField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="group block">
      <span className="font-numeric text-fs-micro tracking-widest text-muted">{label}</span>
      <span className="mt-1 block border-b border-border pb-1.5 transition-colors group-focus-within:border-accent group-focus-within:shadow-glow-accent">
        {children}
      </span>
      {hint && (
        <span className="mt-1 block text-fs-micro leading-relaxed text-faint">{hint}</span>
      )}
    </label>
  );
}

export const LETTER_INPUT =
  "w-full bg-transparent font-body text-fs-body text-fg outline-none placeholder:text-faint";
