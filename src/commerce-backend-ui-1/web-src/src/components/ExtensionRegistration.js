import { register } from '@adobe/uix-guest';
import { useEffect } from 'react';

import { BadgeRulesPage } from './BadgeRulesPage';
import { extensionId } from './Constants';

export default function ExtensionRegistration (props) {
  useEffect(() => {
    (async () => {
      await register({
        id: extensionId,
        methods: {},
      });
    })();
  }, []);

  return <BadgeRulesPage ims={props.ims} runtime={props.runtime} />;
}
