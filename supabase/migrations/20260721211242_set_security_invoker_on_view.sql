/*
# Explicitly set security_invoker on execution_pnl view

## Summary
- Set `security_invoker = true` reloption on `execution_pnl` view
- This makes it explicit that the view runs with the caller's privileges, not the view owner's
- The view was already recreated without SECURITY DEFINER in the previous migration
- This makes the security property explicit and visible in reloptions

## Security changes
- View execution_pnl: explicitly set security_invoker = true
*/

ALTER VIEW public.execution_pnl SET (security_invoker = true);
