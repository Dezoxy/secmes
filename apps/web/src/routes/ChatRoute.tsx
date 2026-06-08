import ChatScreen from '../features/chat/ChatScreen';
import { DeviceProvider } from '../features/device/DeviceContext';
import { UnlockGate } from '../features/device/UnlockGate';
import { AuthenticatedRouteBoundary } from './AuthenticatedRouteBoundary';

export default function ChatRoute() {
  return (
    <AuthenticatedRouteBoundary>
      <DeviceProvider>
        <UnlockGate>
          <ChatScreen />
        </UnlockGate>
      </DeviceProvider>
    </AuthenticatedRouteBoundary>
  );
}
