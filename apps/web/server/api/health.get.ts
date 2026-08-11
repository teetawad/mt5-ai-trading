export default defineEventHandler(() => {
  return {
    status: 'ok',
    service: 'web',
    mode: 'PAPER',
    timestamp: new Date().toISOString(),
  };
});
