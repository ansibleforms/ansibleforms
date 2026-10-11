<script setup>
/******************************************************************/
/*                                                                */
/*  App AnsibleForms Settings Sidebar menu                        */
/*                                                                */
/*  Every entry carries the role option its PAGE requires, and    */
/*  the menu is filtered on it. Keep that field in step with the  */
/*  route's `beforeEnter` guard in router/index.js - if the two   */
/*  disagree the menu offers a link that bounces the user back    */
/*  home, which has happened twice in this codebase.              */
/*                                                                */
/*  It matters because the guards are NOT uniform : showSettings  */
/*  covers most pages, while backups and the server log each      */
/*  have their own option. Filtering per item means an unusable   */
/*  link cannot be rendered, rather than relying on someone       */
/*  remembering to wrap a section by hand.                        */
/*                                                                */
/*  The scheduled and stored jobs are in the jobs menu            */
/*  (AppJobsSidebar), which follows the same rule.                */
/*                                                                */
/******************************************************************/

import { useI18n } from 'vue-i18n';
import { computed } from 'vue';
import { useAppStore } from '@/stores/app';
import { mayOpen } from '@/lib/routePermission';

const { t } = useI18n();
const store = useAppStore();

// an item shows when the user may open its link : the role option of its route
// (lib/routePermission.js), never restated here

const sections = computed(() =>
  [
    {
      // The instance itself : configure it, check its health, back it up. First,
      // because "where do I set the url / what version is this / is anything
      // broken" is what an admin opens this menu for most often.
      title: t('sidebar.sections.system'),
      items: [
        { title: t('sidebar.ansibleForms'), icon: 'toolbox', link: '/settings/general' },
        { title: t('sidebar.logo'), icon: 'image', link: '/settings/logo' },
        { title: t('sidebar.status'), icon: 'heart-pulse', link: '/settings/status' },
        // the database backups : the instance's own data, so with the instance
        { title: t('sidebar.backups'), icon: 'database', link: '/settings/backups' },
      ],
    },
    {
      // Who may sign in, and what they may do once in. Roles lives here rather
      // than with the other two config.yaml editors : sharing code is not a reason
      // to group them, and permissions belong next to users and groups.
      title: t('sidebar.sections.access'),
      items: [
        { title: t('sidebar.users'), icon: 'user', link: '/settings/users' },
        { title: t('sidebar.groups'), icon: 'users', link: '/settings/groups' },
        // 'user-shield' not 'users' : groups already own the people icon, and
        // roles are about what a member may do, not who the members are
        { title: t('sidebar.roles'), icon: 'user-shield', link: '/settings/roles' },
        { title: t('sidebar.ldap'), icon: 'address-book', link: '/settings/ldap' },
        { title: t('sidebar.oauth2'), icon: 'right-to-bracket', link: '/settings/sso' },
      ],
    },
    {
      // Outbound : the systems AnsibleForms reaches and the credentials for them.
      // Mail belongs here rather than under a section of its own - it is an smtp
      // host with a port, tls and a username/password, the same shape as runners and
      // repositories, and it has the same 'test the connection' action.
      title: t('sidebar.sections.connections'),
      items: [
        { title: t('sidebar.mail'), icon: 'envelope', link: '/settings/mail' },
        { title: t('sidebar.credentials'), icon: 'lock', link: '/settings/credentials' },
        { title: t('sidebar.secretStores'), icon: 'vault', link: '/settings/secret-stores' },
        { title: t('sidebar.ssh'), icon: 'key', link: '/settings/ssh' },
        { title: t('sidebar.knownHosts'), icon: 'server', link: '/settings/known-hosts' },
        { title: t('sidebar.runners'), icon: 'rocket', link: '/settings/runners' },
        {
          title: t('sidebar.repositories'),
          icon: 'fab,git',
          link: '/settings/repositories',
        },
        { title: t('sidebar.chat'), icon: 'comments', link: '/settings/chat' },
        { title: t('sidebar.mcp'), icon: 'robot', link: '/settings/mcp' },
      ],
    },
    {
      // What happened on the instance : who changed what (the audit log), and what
      // the server itself reported (the server log, for troubleshooting). Last : the
      // sections above are what you set up, these are read afterwards.
      title: t('sidebar.sections.logs'),
      items: [
        { title: t('sidebar.audit'), icon: 'clipboard-list', link: '/settings/audit-log' },
        { title: t('sidebar.logs'), icon: 'file-lines', link: '/settings/server-log' },
      ],
    },
  ]
    .map((s) => ({ ...s, items: s.items.filter((i) => mayOpen(i.link, store.profile?.options)) }))
    .filter((s) => s.items.length > 0),
);
</script>
<template>
  <BsSidebar :sections="sections" />
</template>
<style scoped></style>
