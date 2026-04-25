export const routes = {
  home: '/',
  dashboard: '/dashboard',
  wizardBuilder: '/wizard-builder'
} as const;

export type AppRoute = (typeof routes)[keyof typeof routes];
