export const routes = {
  home: '/',
  wizardBuilder: '/wizard-builder'
} as const;

export type AppRoute = (typeof routes)[keyof typeof routes];
