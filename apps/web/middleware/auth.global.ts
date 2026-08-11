export default defineNuxtRouteMiddleware(async (to) => {
  const { user, checked, fetchCurrentUser } = useAuth();
  const isLoginRoute = to.path === '/login';

  if (!checked.value) {
    await fetchCurrentUser();
  }

  if (!user.value && !isLoginRoute) {
    return navigateTo({
      path: '/login',
      query: { redirect: to.fullPath },
    });
  }

  if (user.value && isLoginRoute) {
    const redirect = typeof to.query.redirect === 'string' ? to.query.redirect : '/';
    return navigateTo(redirect.startsWith('/') ? redirect : '/');
  }
});
