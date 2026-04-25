export const routes = {
  home: '/'
} as const;

export type AppRoute = (typeof routes)[keyof typeof routes];
