// Importação dos módulos necessários
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config(); // Carrega as variáveis de ambiente do arquivo .env

// Inicialização do aplicativo Express
const app = express();
const port = 3000;

// Configuração dos middlewares
app.use(cors()); // Habilita o CORS para permitir requisições do frontend
app.use(express.json()); // Habilita o parsing de JSON no corpo das requisições

// Validação da chave da API do Asaas
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
if (!ASAAS_API_KEY) {
    console.error("ERRO: A variável de ambiente ASAAS_API_KEY não está definida.");
    process.exit(1); // Encerra o processo se a chave não for encontrada
}

// Configuração do Axios para se comunicar com a API do Asaas
const asaasAPI = axios.create({
    baseURL: 'https://api.asaas.com/v3', // URL base da API do Asaas. Mude para https://sandbox.asaas.com/v3 para testes.
    headers: {
        'access_token': ASAAS_API_KEY,
        'Content-Type': 'application/json'
    }
});

// --- ROTAS DA NOSSA API ---

// Rota para criar um novo cliente e, em seguida, uma cobrança para ele
app.post('/api/create-customer-and-payment', async (req, res) => {
    const { name, cpfCnpj, value, dueDate } = req.body;

    if (!name || !cpfCnpj || !value || !dueDate) {
        return res.status(400).json({ message: "Todos os campos são obrigatórios." });
    }

    try {
        // 1. Criar o cliente no Asaas
        const customerResponse = await asaasAPI.post('/customers', {
            name,
            cpfCnpj
        });
        const customerId = customerResponse.data.id;

        // 2. Criar a cobrança para o cliente recém-criado
        const paymentResponse = await asaasAPI.post('/payments', {
            customer: customerId,
            billingType: 'BOLETO', // ou PIX, CREDIT_CARD
            value,
            dueDate,
            description: `Mensalidade da creche para ${name}`
        });

        res.status(201).json({ 
            customer: customerResponse.data, 
            payment: paymentResponse.data 
        });

    } catch (error) {
        console.error('Erro ao criar cliente ou pagamento:', error.response?.data || error.message);
        res.status(500).json({ message: 'Erro ao processar a criação no Asaas.', details: error.response?.data });
    }
});


// Rota para obter o status de pagamento de todos os alunos
app.get('/api/students-status', async (req, res) => {
    try {
        // 1. Pega todos os clientes
        const { data: customersData } = await asaasAPI.get('/customers?limit=100');
        const customers = customersData.data;

        if (!customers || customers.length === 0) {
            return res.json({ students: [] });
        }

        // 2. Para cada cliente, busca suas cobranças
        const studentStatusPromises = customers.map(async (customer) => {
            const { data: paymentsData } = await asaasAPI.get(`/payments?customer=${customer.id}`);
            const payments = paymentsData.data;

            let status = 'ADIMPLENTE';
            let nextDueDate = 'N/A';
            let monthlyFee = 0; // Valor da mensalidade

            const hasOverdue = payments.some(p => p.status === 'OVERDUE');
            if (hasOverdue) {
                status = 'INADIMPLENTE';
            }
            
            const pendingPayments = payments.filter(p => p.status === 'PENDING' || p.status === 'OVERDUE');
            if (pendingPayments.length > 0) {
                pendingPayments.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
                nextDueDate = pendingPayments[0].dueDate;
                monthlyFee = pendingPayments[0].value;
            } else {
                 if(payments.length > 0) {
                    payments.sort((a, b) => new Date(b.dueDate) - new Date(a.dueDate));
                    const lastDueDate = new Date(payments[0].dueDate);
                    lastDueDate.setDate(lastDueDate.getDate() + 30);
                    nextDueDate = lastDueDate.toISOString().split('T')[0];
                    monthlyFee = payments[0].value;
                 } else {
                    nextDueDate = 'Sem cobranças';
                 }
            }

            return {
                id: customer.id,
                name: customer.name,
                status,
                nextDueDate,
                monthlyFee,
            };
        });

        const students = await Promise.all(studentStatusPromises);

        res.json({ students });

    } catch (error) {
        console.error('Erro ao obter status dos alunos:', error.response?.data || error.message);
        res.status(500).json({ message: 'Erro ao obter status dos alunos.' });
    }
});

// Rota para gerar relatório de receitas (pagamentos recebidos)
app.get('/api/revenue-report', async (req, res) => {
    try {
        const { data: customersData } = await asaasAPI.get('/customers?limit=100');
        const customers = customersData.data;
        const customerMap = new Map(customers.map(c => [c.id, c.name]));

        const { data: paymentsData } = await asaasAPI.get('/payments?status=RECEIVED&limit=100');
        const receivedPayments = paymentsData.data;

        const reportData = receivedPayments.map(payment => ({
            id: payment.id,
            customerName: customerMap.get(payment.customer) || 'Cliente não encontrado',
            value: payment.value,
            paymentDate: payment.paymentDate,
            invoiceUrl: payment.invoiceUrl
        }));

        res.json({ report: reportData });

    } catch (error) {
        console.error('Erro ao gerar relatório de receitas:', error.response?.data || error.message);
        res.status(500).json({ message: 'Erro ao gerar relatório de receitas.' });
    }
});

// NOVA ROTA: Rota para criar uma nova receita avulsa
app.post('/api/create-revenue', async (req, res) => {
    const { customerId, description, value, dueDate, category } = req.body;

    if (!customerId || !description || !value || !dueDate || !category) {
        return res.status(400).json({ message: "Todos os campos são obrigatórios." });
    }

    try {
        const paymentResponse = await asaasAPI.post('/payments', {
            customer: customerId,
            billingType: 'BOLETO',
            value,
            dueDate,
            description: `[${category}] ${description}` // Combina categoria e descrição
        });

        res.status(201).json({ payment: paymentResponse.data });

    } catch (error) {
        console.error('Erro ao criar nova receita:', error.response?.data || error.message);
        res.status(500).json({ message: 'Erro ao criar nova receita no Asaas.', details: error.response?.data });
    }
});


// Inicia o servidor
app.listen(port, () => {
    console.log(`🚀 Servidor rodando na porta ${port}`);
});

