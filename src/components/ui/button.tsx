import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "@radix-ui/react-slot";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 font-medium select-none rounded-md font-sans transition-[scale,background-color,color,opacity] duration-150 ease-out active:not-disabled:scale-[0.96] disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-phosphor",
  {
    variants: {
      variant: {
        primary:
          "bg-phosphor text-phosphor-ink hover:bg-phosphor/90",
        ghost:
          "bg-transparent text-fg hover:bg-surface-2",
        outline:
          "bg-transparent text-fg shadow-[0_0_0_1px_rgba(61,255,138,0.16)] hover:bg-surface-2",
        danger:
          "bg-loss/15 text-loss hover:bg-loss/25",
      },
      size: {
        sm: "h-9 px-3 text-xs",
        md: "h-11 px-4 text-sm",
        icon: "size-11",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}
