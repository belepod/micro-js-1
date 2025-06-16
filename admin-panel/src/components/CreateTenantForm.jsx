import React, { useState } from 'react';

function CreateTenantForm({ onSubmit }) {
    const [formData, setFormData] = useState({
        tenantId: '', organizationName: '', logoUrl: '', subdomain: '',
        address: '', timezone: '', currency: '',
        username: '', password: ''
    });

    const handleChange = (e) => {
        setFormData({ ...formData, [e.target.name]: e.target.value });
    };

    const handleSubmit = (e) => {
        e.preventDefault();
        onSubmit(formData);
    };

    return (
        <div className="form-container" style={{ marginTop: '2rem' }}>
            <h3>New Tenant Details</h3>
            <form onSubmit={handleSubmit} className="form-grid">
                {/* Tenant Info */}
                <div><label>Tenant ID*</label><input name="tenantId" onChange={handleChange} required /></div>
                <div><label>Organization Name*</label><input name="organizationName" onChange={handleChange} required /></div>
                <div><label>Logo URL</label><input name="logoUrl" onChange={handleChange} /></div>
                <div><label>Desired Subdomain</label><input name="subdomain" onChange={handleChange} /></div>
                <div><label>Address</label><input name="address" onChange={handleChange} /></div>
                <div><label>Timezone</label><input name="timezone" onChange={handleChange} /></div>
                <div><label>Currency (e.g., USD)</label><input name="currency" onChange={handleChange} /></div>
                <div />

                {/* Initial User Info */}
                <div className="full-width"><h3>Initial Admin User for Tenant</h3></div>
                <div><label>Username*</label><input name="username" onChange={handleChange} required /></div>
                <div><label>Password*</label><input name="password" type="password" onChange={handleChange} required /></div>
                
                <div className="full-width">
                    <button type="submit">Create Tenant and User</button>
                </div>
            </form>
        </div>
    );
}

export default CreateTenantForm;
