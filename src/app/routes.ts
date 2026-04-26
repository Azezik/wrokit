export const routes = {
  home: '/',
  dashboard: '/dashboard',
  wizardBuilder: '/wizard-builder',
  configCapture: '/config-capture'
} as const;

export type AppRoute = (typeof routes)[keyof typeof routes];
