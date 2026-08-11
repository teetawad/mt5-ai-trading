<template>
  <div class="min-h-screen bg-gray-900 text-white flex flex-col">
    <PaperTradingBanner />
    <nav class="bg-gray-800 border-b border-gray-700 px-6 py-3 shrink-0">
      <div class="max-w-7xl mx-auto flex items-center justify-between">
        <span class="text-lg font-semibold tracking-tight">Trade Platform</span>
        <span class="text-xs text-amber-400 font-bold tracking-widest">PAPER MODE</span>
      </div>
    </nav>
    <main class="flex-1 max-w-7xl mx-auto w-full px-6 py-8">
      <slot />
    </main>
  </div>
</template>
