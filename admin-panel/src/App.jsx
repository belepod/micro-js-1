import React, { useState } from 'react';
import LoginPage from './components/LoginPage';
import DashboardPage from './components/DashboardPage';

function App() {
    const [isAuthenticated, setIsAuthenticated] = useState(!!document.cookie.includes('admin-session'));

    const handleLoginSuccess = () => {
        setIsAuthenticated(true);
    };

    return (
        <div className="container">
            <h1>Tenant Management Control Panel</h1>
            {isAuthenticated ? (
                <DashboardPage />
            ) : (
                <LoginPage onLoginSuccess={handleLoginSuccess} />
            )}
        </div>
    );
}

export default App;
