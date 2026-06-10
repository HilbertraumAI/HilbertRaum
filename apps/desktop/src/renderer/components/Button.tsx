import { forwardRef, type ButtonHTMLAttributes } from 'react'

// Button (guidelines §6): exactly three levels — Primary (--accent-600 fill, ONE per
// view), Secondary (surface + --border-strong outline, the default), Ghost (text only).
// Focus ring + hit targets come from the global CSS baseline; `type` defaults to
// "button" so a Button inside a <form> never submits by accident.

export type ButtonVariant = 'primary' | 'secondary' | 'ghost'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className, type = 'button', ...rest },
  ref
): JSX.Element {
  const classes = ['btn']
  if (variant !== 'secondary') classes.push(variant)
  if (size === 'sm') classes.push('sm')
  if (className) classes.push(className)
  return <button ref={ref} type={type} className={classes.join(' ')} {...rest} />
})
